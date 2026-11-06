//! Language servers for the editor: settings in `<data_dir>/lsp.json`, the
//! trust a person gives once per repo, and commands over the `xdev_lsp`
//! pool. Positions pass through as the editor sent them (UTF-16, 0-based).

use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::State;
use tauri::ipc::Channel;
use xdev_lsp::convert;
use xdev_lsp::docs::rel_of;
use xdev_lsp::{
    CompletionList, Diagnostic, Hover, Launch, Location, LspError, LspLanguage, Pool, Pos, Range,
    State as LspState, Status, Symbol, WorkspaceEdit,
};

use crate::accounts::data_dir;
use crate::applog;
use crate::atomic::write_atomic;
use crate::commands::{AppState, CmdError};
use crate::network::repo_for_cwd;
use crate::workspace::known_checkout;

pub const IDLE_MINUTES_DEFAULT: u32 = 10;
pub const IDLE_MINUTES_MIN: u32 = 1;
pub const IDLE_MINUTES_MAX: u32 = 120;

const HOVER_TIMEOUT: Duration = Duration::from_secs(5);
const DEFINITION_TIMEOUT: Duration = Duration::from_secs(5);
const PREPARE_RENAME_TIMEOUT: Duration = Duration::from_secs(5);
const COMPLETION_TIMEOUT: Duration = Duration::from_secs(3);
const RENAME_TIMEOUT: Duration = Duration::from_secs(10);
const SYMBOLS_TIMEOUT: Duration = Duration::from_secs(5);

const FILE: &str = "lsp.json";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LspSettings {
    /// The master switch.
    pub enabled: bool,
    pub disabled: Vec<LspLanguage>,
    /// A server unused this long stops.
    pub idle_minutes: u32,
    /// Repos a person allowed servers in, as paths.
    pub trusted: Vec<String>,
}

impl Default for LspSettings {
    fn default() -> Self {
        LspSettings {
            enabled: true,
            disabled: Vec::new(),
            idle_minutes: IDLE_MINUTES_DEFAULT,
            trusted: Vec::new(),
        }
    }
}

impl LspSettings {
    /// Each field read on its own: a field that does not parse keeps its
    /// default, an unknown language is dropped.
    pub fn from_value(v: &Value) -> LspSettings {
        let d = LspSettings::default();
        let mut disabled: Vec<LspLanguage> = v["disabled"]
            .as_array()
            .map(|all| {
                all.iter()
                    .filter_map(|l| serde_json::from_value(l.clone()).ok())
                    .collect()
            })
            .unwrap_or_default();
        disabled.sort();
        disabled.dedup();
        let mut trusted: Vec<String> = Vec::new();
        for t in v["trusted"].as_array().into_iter().flatten() {
            if let Some(t) = t.as_str().filter(|t| !t.is_empty())
                && !trusted.iter().any(|k| k == t)
            {
                trusted.push(t.to_owned());
            }
        }
        LspSettings {
            enabled: v["enabled"].as_bool().unwrap_or(d.enabled),
            disabled,
            idle_minutes: v["idleMinutes"].as_u64().map_or(d.idle_minutes, |m| {
                m.clamp(u64::from(IDLE_MINUTES_MIN), u64::from(IDLE_MINUTES_MAX)) as u32
            }),
            trusted,
        }
    }

    fn idle(&self) -> Duration {
        Duration::from_secs(u64::from(self.idle_minutes) * 60)
    }

    fn is_trusted(&self, repo: &str) -> bool {
        let key = xdev_workspace::path_key(Path::new(repo));
        self.trusted
            .iter()
            .any(|t| xdev_workspace::path_key(Path::new(t)) == key)
    }

    /// Adds or drops `repo`; doing it twice changes nothing.
    pub fn set_trust(&mut self, repo: &str, trusted: bool) {
        let key = xdev_workspace::path_key(Path::new(repo));
        self.trusted
            .retain(|t| xdev_workspace::path_key(Path::new(t)) != key);
        if trusted {
            self.trusted.push(repo.to_owned());
        }
    }
}

/// The settings on disk; a missing or broken file gives the defaults.
pub fn load_settings(data: &Path) -> LspSettings {
    fs::read(data.join(FILE))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .map(|v| LspSettings::from_value(&v))
        .unwrap_or_default()
}

fn save_settings(data: &Path, s: &LspSettings) -> Result<(), CmdError> {
    let bytes = serde_json::to_vec_pretty(s).map_err(|e| CmdError {
        code: "io",
        detail: Some(e.to_string()),
    })?;
    write_atomic(&data.join(FILE), &bytes).map_err(|e| CmdError {
        code: "io",
        detail: Some(e.kind().to_string()),
    })
}

/// One language row of Settings → Code intelligence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LspServerInfo {
    pub language: LspLanguage,
    /// The program found, or the one to install when none is.
    pub program: String,
    pub path: Option<String>,
    pub enabled: bool,
    /// Worktrees it runs in.
    pub running: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LspEvent {
    Diagnostics {
        worktree: String,
        rel: String,
        items: Vec<Diagnostic>,
    },
    Status {
        worktree: String,
        language: LspLanguage,
        state: LspState,
    },
}

/// What opening a document did. `language` is None for a language no
/// server serves.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LspDocState {
    pub language: Option<LspLanguage>,
    pub state: LspState,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LspRunning {
    pub worktree: String,
    pub language: LspLanguage,
    pub state: LspState,
    pub open_docs: u32,
}

type Found = Vec<(LspLanguage, Option<(String, PathBuf)>)>;
type Sink = Arc<Mutex<Option<Box<dyn Fn(LspEvent) + Send>>>>;

fn emit(sink: &Sink, event: LspEvent) {
    if let Some(f) = sink.lock().unwrap_or_else(PoisonError::into_inner).as_ref() {
        f(event);
    }
}

fn log_status(s: &Status) {
    let what = format!("{} ({})", s.program, s.language.as_str());
    match s.state {
        LspState::Ready => applog::info("lsp", &format!("{what} started")),
        LspState::Stopped => applog::info("lsp", &format!("{what} stopped")),
        LspState::Crashed => applog::warn("lsp", &format!("{what} crashed")),
        LspState::Starting | LspState::NotFound => {}
    }
}

pub struct LspHub {
    pool: Pool,
    sink: Sink,
    /// The last detection; None until the first.
    found: Mutex<Option<Found>>,
    /// Repos a person said no to this session: not asked again.
    untrusted_session: Mutex<HashSet<String>>,
}

impl Default for LspHub {
    fn default() -> Self {
        let sink: Sink = Arc::default();
        let status_sink = sink.clone();
        let notify_sink = sink.clone();
        let pool = Pool::new(
            Box::new(move |s: Status| {
                log_status(&s);
                emit(
                    &status_sink,
                    LspEvent::Status {
                        worktree: s.worktree.display().to_string(),
                        language: s.language,
                        state: s.state,
                    },
                );
            }),
            Box::new(move |worktree, _language, method, params| {
                if method != "textDocument/publishDiagnostics" {
                    return;
                }
                let Some((uri, items)) = convert::diagnostics(params) else {
                    return;
                };
                let Some(rel) = rel_of(worktree, &uri) else {
                    return;
                };
                emit(
                    &notify_sink,
                    LspEvent::Diagnostics {
                        worktree: worktree.display().to_string(),
                        rel,
                        items,
                    },
                );
            }),
        );
        LspHub {
            pool,
            sink,
            found: Mutex::new(None),
            untrusted_session: Mutex::new(HashSet::new()),
        }
    }
}

impl LspHub {
    /// For app exit.
    pub fn stop_all(&self) {
        self.pool.stop_all();
    }

    fn found(&self, refresh: bool) -> Found {
        let mut found = self.found.lock().unwrap_or_else(PoisonError::into_inner);
        if refresh || found.is_none() {
            *found = Some(xdev_lsp::detect(&xdev_agent::find_program));
        }
        found.clone().unwrap_or_default()
    }

    fn session_untrusted(&self, repo: &str) -> bool {
        self.untrusted_session
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains(&xdev_workspace::path_key(Path::new(repo)))
    }
}

fn err(code: &'static str, detail: Option<String>) -> CmdError {
    CmdError { code, detail }
}

fn lsp_error(e: LspError) -> CmdError {
    let detail = Some(e.to_string());
    match e {
        LspError::Timeout | LspError::Starting => err("lsp_timeout", detail),
        LspError::Closed | LspError::Crashed | LspError::Spawn(_) | LspError::Io(_) => {
            err("lsp_crashed", detail)
        }
        LspError::Unsupported | LspError::Rpc { .. } => err("lsp_unsupported", detail),
        LspError::NotOpen => err("not_found", detail),
        LspError::Outside => err("outside", detail),
    }
}

/// An error answer from the server is an empty answer; the rest are errors.
fn or_empty<T>(
    r: Result<Value, LspError>,
    f: impl FnOnce(Value) -> T,
    empty: T,
) -> Result<T, CmdError> {
    match r {
        Ok(v) => Ok(f(v)),
        Err(LspError::Rpc { .. }) => Ok(empty),
        Err(e) => Err(lsp_error(e)),
    }
}

/// A worktree-relative path with `/`, only plain parts.
fn check_rel(rel: &str) -> Result<(), CmdError> {
    let ok = !rel.is_empty()
        && rel.split('/').all(|p| {
            let mut c = Path::new(p).components();
            matches!((c.next(), c.next()), (Some(Component::Normal(_)), None))
        });
    if ok {
        Ok(())
    } else {
        Err(err("outside", None))
    }
}

/// The data dir, once `worktree` is known to the workspace.
fn checked<'a>(state: &'a AppState, worktree: &Path) -> Result<&'a Path, CmdError> {
    let data = data_dir(state)?;
    known_checkout(data, worktree)?;
    Ok(data)
}

/// The repo a worktree belongs to, as the path trust is kept under.
fn repo_of(data: &Path, worktree: &Path) -> String {
    xdev_workspace::Registry::load(data)
        .ok()
        .and_then(|reg| repo_for_cwd(&reg, worktree).map(|r| r.path.clone()))
        .unwrap_or_else(|| worktree.to_path_buf())
        .display()
        .to_string()
}

/// Whether a document may get a server, in the order a person can fix
/// things: everything off, this language off, the repo not trusted, the
/// program missing. `Ok(None)` for a language no server serves.
pub fn open_check(
    settings: &LspSettings,
    language: Option<LspLanguage>,
    repo: &str,
    session_untrusted: bool,
    find: &dyn Fn(LspLanguage) -> Option<(String, PathBuf)>,
) -> Result<Option<(LspLanguage, Launch)>, CmdError> {
    if !settings.enabled {
        return Err(err("lsp_off", None));
    }
    let Some(language) = language else {
        return Ok(None);
    };
    if settings.disabled.contains(&language) {
        return Err(err("lsp_off", Some(language.as_str().into())));
    }
    if session_untrusted {
        return Err(err("lsp_untrusted", Some("session".into())));
    }
    if !settings.is_trusted(repo) {
        return Err(err("lsp_untrusted", None));
    }
    let Some((name, program)) = find(language) else {
        return Err(err("lsp_not_found", Some(language.as_str().into())));
    };
    let args = xdev_lsp::catalog::args_of(language, &name)
        .iter()
        .map(|a| (*a).to_owned())
        .collect();
    Ok(Some((
        language,
        Launch {
            program,
            args,
            path_env: xdev_agent::path_override(),
        },
    )))
}

/// The rows of Settings → Code intelligence.
fn server_rows(settings: &LspSettings, found: &Found, running: &[Status]) -> Vec<LspServerInfo> {
    found
        .iter()
        .map(|(language, hit)| {
            let program = hit.as_ref().map_or_else(
                || xdev_lsp::candidates(*language)[0].0.to_owned(),
                |(name, _)| name.clone(),
            );
            let worktrees: HashSet<_> = running
                .iter()
                .filter(|s| {
                    s.language == *language
                        && matches!(s.state, LspState::Starting | LspState::Ready)
                })
                .map(|s| &s.worktree)
                .collect();
            LspServerInfo {
                language: *language,
                program,
                path: hit.as_ref().map(|(_, p)| p.display().to_string()),
                enabled: settings.enabled && !settings.disabled.contains(language),
                running: worktrees.len() as u32,
            }
        })
        .collect()
}

#[tauri::command(async)]
pub fn lsp_servers(
    state: State<'_, AppState>,
    hub: State<'_, LspHub>,
    refresh: bool,
) -> Result<Vec<LspServerInfo>, CmdError> {
    let settings = load_settings(data_dir(&state)?);
    Ok(server_rows(
        &settings,
        &hub.found(refresh),
        &hub.pool.status(),
    ))
}

#[tauri::command(async)]
pub fn lsp_settings_get(state: State<'_, AppState>) -> Result<LspSettings, CmdError> {
    Ok(load_settings(data_dir(&state)?))
}

/// Saves the settings and stops the servers they turned off.
#[tauri::command(async)]
pub fn lsp_settings_put(
    state: State<'_, AppState>,
    hub: State<'_, LspHub>,
    settings: LspSettings,
) -> Result<LspSettings, CmdError> {
    let data = data_dir(&state)?;
    let settings = LspSettings::from_value(&json!(settings));
    save_settings(data, &settings)?;
    hub.pool.set_idle(settings.idle());
    if !settings.enabled {
        hub.pool.stop_language(None);
    } else {
        for language in &settings.disabled {
            hub.pool.stop_language(Some(*language));
        }
    }
    Ok(settings)
}

/// The last subscriber gets the events; before one, they are dropped.
#[tauri::command(async)]
pub fn lsp_subscribe(hub: State<'_, LspHub>, on_event: Channel<LspEvent>) {
    *hub.sink.lock().unwrap_or_else(PoisonError::into_inner) = Some(Box::new(move |e| {
        let _ = on_event.send(e);
    }));
}

/// Yes keeps the worktree's repo trusted; no drops it and stops asking for
/// the rest of the session.
#[tauri::command(async)]
pub fn lsp_trust(
    state: State<'_, AppState>,
    hub: State<'_, LspHub>,
    worktree: PathBuf,
    trusted: bool,
) -> Result<(), CmdError> {
    let data = checked(&state, &worktree)?;
    let repo = repo_of(data, &worktree);
    {
        let mut session = hub
            .untrusted_session
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let key = xdev_workspace::path_key(Path::new(&repo));
        if trusted {
            session.remove(&key);
        } else {
            session.insert(key);
        }
    }
    let mut settings = load_settings(data);
    let before = settings.clone();
    settings.set_trust(&repo, trusted);
    if settings != before {
        save_settings(data, &settings)?;
    }
    Ok(())
}

#[tauri::command(async)]
pub fn lsp_open(
    state: State<'_, AppState>,
    hub: State<'_, LspHub>,
    worktree: PathBuf,
    rel: String,
    language_id: String,
    version: i32,
    text: String,
) -> Result<LspDocState, CmdError> {
    let data = checked(&state, &worktree)?;
    check_rel(&rel)?;
    let settings = load_settings(data);
    let repo = repo_of(data, &worktree);
    let found = hub.found(false);
    let find = |language: LspLanguage| {
        found
            .iter()
            .find(|(l, _)| *l == language)
            .and_then(|(_, hit)| hit.clone())
    };
    let checked = open_check(
        &settings,
        xdev_lsp::language_of(&language_id),
        &repo,
        hub.session_untrusted(&repo),
        &find,
    )?;
    let Some((language, launch)) = checked else {
        return Ok(LspDocState {
            language: None,
            state: LspState::NotFound,
        });
    };
    hub.pool.set_idle(settings.idle());
    let state = hub
        .pool
        .open(
            &worktree,
            language,
            launch,
            &rel,
            &language_id,
            version,
            text,
        )
        .map_err(lsp_error)?;
    Ok(LspDocState {
        language: Some(language),
        state,
    })
}

#[tauri::command(async)]
pub fn lsp_change(
    state: State<'_, AppState>,
    hub: State<'_, LspHub>,
    worktree: PathBuf,
    rel: String,
    version: i32,
    text: String,
) -> Result<(), CmdError> {
    checked(&state, &worktree)?;
    check_rel(&rel)?;
    hub.pool
        .change(&worktree, &rel, version, text)
        .map_err(lsp_error)
}

#[tauri::command(async)]
pub fn lsp_close(
    state: State<'_, AppState>,
    hub: State<'_, LspHub>,
    worktree: PathBuf,
    rel: String,
) -> Result<(), CmdError> {
    checked(&state, &worktree)?;
    check_rel(&rel)?;
    hub.pool.close(&worktree, &rel);
    Ok(())
}

#[tauri::command(async)]
pub fn lsp_hover(
    state: State<'_, AppState>,
    hub: State<'_, LspHub>,
    worktree: PathBuf,
    rel: String,
    pos: Pos,
) -> Result<Option<Hover>, CmdError> {
    checked(&state, &worktree)?;
    check_rel(&rel)?;
    let r = hub.pool.request(
        &worktree,
        &rel,
        "textDocument/hover",
        json!({"position": pos}),
        HOVER_TIMEOUT,
        |c| c.hover,
    );
    or_empty(r, convert::hover, None)
}

#[tauri::command(async)]
pub fn lsp_definition(
    state: State<'_, AppState>,
    hub: State<'_, LspHub>,
    worktree: PathBuf,
    rel: String,
    pos: Pos,
) -> Result<Vec<Location>, CmdError> {
    checked(&state, &worktree)?;
    check_rel(&rel)?;
    let r = hub.pool.request(
        &worktree,
        &rel,
        "textDocument/definition",
        json!({"position": pos}),
        DEFINITION_TIMEOUT,
        |c| c.definition,
    );
    or_empty(r, |v| convert::locations(v, &worktree), Vec::new())
}

#[tauri::command(async)]
pub fn lsp_completion(
    state: State<'_, AppState>,
    hub: State<'_, LspHub>,
    worktree: PathBuf,
    rel: String,
    pos: Pos,
) -> Result<CompletionList, CmdError> {
    checked(&state, &worktree)?;
    check_rel(&rel)?;
    let r = hub.pool.request(
        &worktree,
        &rel,
        "textDocument/completion",
        json!({"position": pos, "context": {"triggerKind": 1}}),
        COMPLETION_TIMEOUT,
        |c| c.completion,
    );
    or_empty(r, convert::completion, CompletionList::default())
}

/// The range a rename would change. A server without `prepareRename` gets
/// the word at the caret.
#[tauri::command(async)]
pub fn lsp_prepare_rename(
    state: State<'_, AppState>,
    hub: State<'_, LspHub>,
    worktree: PathBuf,
    rel: String,
    pos: Pos,
) -> Result<Option<Range>, CmdError> {
    checked(&state, &worktree)?;
    check_rel(&rel)?;
    let caps = hub.pool.caps_of(&worktree, &rel).map_err(lsp_error)?;
    if !caps.rename {
        return Err(lsp_error(LspError::Unsupported));
    }
    let text = hub.pool.text_of(&worktree, &rel).unwrap_or_default();
    if !caps.prepare_rename {
        return Ok(convert::word_range(&text, pos));
    }
    let r = hub.pool.request(
        &worktree,
        &rel,
        "textDocument/prepareRename",
        json!({"position": pos}),
        PREPARE_RENAME_TIMEOUT,
        |c| c.prepare_rename,
    );
    or_empty(r, |v| convert::prepare_rename(v, &text, pos), None)
}

/// The edits of a rename; nothing is written. A server's refusal is
/// `lsp_unsupported` with its message.
#[tauri::command(async)]
pub fn lsp_rename(
    state: State<'_, AppState>,
    hub: State<'_, LspHub>,
    worktree: PathBuf,
    rel: String,
    pos: Pos,
    new_name: String,
) -> Result<WorkspaceEdit, CmdError> {
    checked(&state, &worktree)?;
    check_rel(&rel)?;
    let v = hub
        .pool
        .request(
            &worktree,
            &rel,
            "textDocument/rename",
            json!({"position": pos, "newName": new_name}),
            RENAME_TIMEOUT,
            |c| c.rename,
        )
        .map_err(lsp_error)?;
    Ok(convert::workspace_edit(v, &worktree))
}

/// Symbols from every ready server of the worktree.
#[tauri::command(async)]
pub fn lsp_workspace_symbols(
    state: State<'_, AppState>,
    hub: State<'_, LspHub>,
    worktree: PathBuf,
    query: String,
) -> Result<Vec<Symbol>, CmdError> {
    checked(&state, &worktree)?;
    let servers = hub.pool.servers_of(&worktree, |c| c.workspace_symbol);
    if servers.is_empty() {
        return Err(err("lsp_not_found", None));
    }
    let mut all = Vec::new();
    for server in servers {
        let r = server.request("workspace/symbol", json!({"query": query}), SYMBOLS_TIMEOUT);
        all.extend(or_empty(r, |v| convert::symbols(v, &worktree), Vec::new())?);
    }
    all.truncate(convert::MAX_SYMBOLS);
    Ok(all)
}

/// Restarts the servers of a worktree, or all of them.
#[tauri::command(async)]
pub fn lsp_restart(
    state: State<'_, AppState>,
    hub: State<'_, LspHub>,
    worktree: Option<PathBuf>,
) -> Result<(), CmdError> {
    if let Some(w) = &worktree {
        checked(&state, w)?;
    }
    hub.pool.restart(worktree.as_deref());
    Ok(())
}

#[tauri::command(async)]
pub fn lsp_status(hub: State<'_, LspHub>) -> Vec<LspRunning> {
    hub.pool
        .status()
        .into_iter()
        .map(|s| LspRunning {
            worktree: s.worktree.display().to_string(),
            language: s.language,
            state: s.state,
            open_docs: s.open_docs as u32,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_broken_file_gives_defaults() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load_settings(dir.path()), LspSettings::default());
        fs::write(dir.path().join(FILE), b"{not json").unwrap();
        assert_eq!(load_settings(dir.path()), LspSettings::default());
    }

    #[test]
    fn fields_load_on_their_own_and_idle_is_clamped() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join(FILE),
            br#"{"enabled": "yes", "disabled": ["rust", "cobol", "rust"], "idleMinutes": 500, "trusted": ["/a", "", "/a", 3]}"#,
        )
        .unwrap();
        let s = load_settings(dir.path());
        assert!(s.enabled);
        assert_eq!(s.disabled, [LspLanguage::Rust]);
        assert_eq!(s.idle_minutes, IDLE_MINUTES_MAX);
        assert_eq!(s.trusted, ["/a"]);
        let low = LspSettings::from_value(&json!({"idleMinutes": 0}));
        assert_eq!(low.idle_minutes, IDLE_MINUTES_MIN);
        save_settings(dir.path(), &s).unwrap();
        assert_eq!(load_settings(dir.path()), s);
    }

    #[test]
    fn trust_add_and_drop_are_idempotent() {
        let mut s = LspSettings::default();
        s.set_trust("/r/one", true);
        s.set_trust("/r/one", true);
        s.set_trust("/r/two", true);
        assert_eq!(s.trusted, ["/r/one", "/r/two"]);
        assert!(s.is_trusted("/r/one"));
        s.set_trust("/r/one", false);
        s.set_trust("/r/one", false);
        assert_eq!(s.trusted, ["/r/two"]);
        assert!(!s.is_trusted("/r/one"));
    }

    fn finder(lang: LspLanguage) -> Option<(String, PathBuf)> {
        (lang == LspLanguage::Typescript).then(|| {
            (
                "typescript-language-server".to_owned(),
                PathBuf::from("/bin/typescript-language-server"),
            )
        })
    }

    #[test]
    fn open_refuses_in_order() {
        let ts = Some(LspLanguage::Typescript);
        let code = |s: &LspSettings, lang, untrusted| {
            open_check(s, lang, "/r", untrusted, &finder).map_err(|e| e.code)
        };
        let mut s = LspSettings {
            enabled: false,
            disabled: vec![LspLanguage::Typescript],
            ..LspSettings::default()
        };
        assert_eq!(code(&s, ts, true).unwrap_err(), "lsp_off");
        s.enabled = true;
        assert_eq!(code(&s, ts, true).unwrap_err(), "lsp_off");
        assert_eq!(code(&s, None, true).unwrap(), None);
        s.disabled.clear();
        assert_eq!(code(&s, ts, false).unwrap_err(), "lsp_untrusted");
        s.set_trust("/r", true);
        let e = open_check(&s, ts, "/r", true, &finder).unwrap_err();
        assert_eq!(
            (e.code, e.detail.as_deref()),
            ("lsp_untrusted", Some("session"))
        );
        assert_eq!(
            code(&s, Some(LspLanguage::Python), false).unwrap_err(),
            "lsp_not_found"
        );
        let (lang, launch) = open_check(&s, ts, "/r", false, &finder).unwrap().unwrap();
        assert_eq!(lang, LspLanguage::Typescript);
        assert_eq!(
            launch.program,
            PathBuf::from("/bin/typescript-language-server")
        );
        assert_eq!(launch.args, ["--stdio"]);
    }

    #[test]
    fn rows_name_the_program_and_count_worktrees() {
        let s = LspSettings {
            disabled: vec![LspLanguage::Go],
            ..LspSettings::default()
        };
        let found = xdev_lsp::detect(&|name| {
            (name == "rust-analyzer").then(|| PathBuf::from("/bin/rust-analyzer"))
        });
        let st = |w: &str, state| Status {
            worktree: PathBuf::from(w),
            language: LspLanguage::Rust,
            state,
            program: "rust-analyzer".into(),
            open_docs: 1,
        };
        let running = [
            st("/a", LspState::Ready),
            st("/b", LspState::Starting),
            st("/c", LspState::Crashed),
        ];
        let rows = server_rows(&s, &found, &running);
        let rust = rows
            .iter()
            .find(|r| r.language == LspLanguage::Rust)
            .unwrap();
        assert_eq!(rust.path.as_deref(), Some("/bin/rust-analyzer"));
        assert_eq!(rust.running, 2);
        let py = rows
            .iter()
            .find(|r| r.language == LspLanguage::Python)
            .unwrap();
        assert_eq!(
            (py.program.as_str(), py.path.as_deref()),
            ("pyright-langserver", None)
        );
        let go = rows.iter().find(|r| r.language == LspLanguage::Go).unwrap();
        assert!(!go.enabled);
    }

    #[test]
    fn rel_paths_stay_inside() {
        assert!(check_rel("src/a.ts").is_ok());
        for bad in ["", "../a", "src/../../a", "/etc/passwd", "a//b", "./a"] {
            assert_eq!(check_rel(bad).unwrap_err().code, "outside", "{bad}");
        }
    }

    #[test]
    fn errors_map_to_codes() {
        assert_eq!(lsp_error(LspError::Timeout).code, "lsp_timeout");
        assert_eq!(lsp_error(LspError::Starting).code, "lsp_timeout");
        assert_eq!(lsp_error(LspError::Closed).code, "lsp_crashed");
        assert_eq!(lsp_error(LspError::Unsupported).code, "lsp_unsupported");
        assert_eq!(lsp_error(LspError::NotOpen).code, "not_found");
        assert_eq!(lsp_error(LspError::Outside).code, "outside");
        assert_eq!(
            or_empty(
                Err(LspError::Rpc {
                    code: 1,
                    message: "x".into()
                }),
                |_| 1,
                0
            ),
            Ok(0)
        );
    }

    #[test]
    fn events_serialize_with_a_kind() {
        let e = LspEvent::Status {
            worktree: "/w".into(),
            language: LspLanguage::Go,
            state: LspState::NotFound,
        };
        assert_eq!(
            serde_json::to_value(e).unwrap(),
            json!({"kind": "status", "worktree": "/w", "language": "go", "state": "notFound"})
        );
    }
}
