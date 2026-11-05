//! Thin Tauri wrappers over `session`. Commands run with `async` so indexing
//! a large vault never blocks the main (UI) thread.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, Manager, State};
use xdev_core::{
    Change, Commit, CoreError, DocEntry, DocLink, ExportPlan, Freshness, Links, SearchHit,
    StaleDoc, Vault,
};
use xdev_workspace::Registry;

use crate::accounts::data_dir;
use crate::links::links_for;
use crate::session::Shared;
use crate::settings;
use crate::settings::SettingsSection;
use crate::settings_store;

pub const CHANGED_EVENT: &str = "vault://changed";

/// The UI translates `code`; `detail` is only for logs and bug reports.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct CmdError {
    pub code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub detail: Option<String>,
}

impl CmdError {
    pub fn no_vault() -> CmdError {
        CmdError {
            code: "no_vault",
            detail: None,
        }
    }
}

impl From<CoreError> for CmdError {
    fn from(e: CoreError) -> CmdError {
        CmdError {
            code: e.code(),
            detail: Some(e.to_string()),
        }
    }
}

/// The payload of `CHANGED_EVENT`.
#[derive(Clone, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(rename = "VaultChanged"))]
pub struct Changed {
    paths: Vec<String>,
}

pub struct AppState {
    pub session: Shared,
    pub data_dir: Option<PathBuf>,
    pub local_dir: Option<PathBuf>,
}

#[tauri::command(async)]
pub fn open_vault(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<DocEntry>, CmdError> {
    let local_dir = crate::accounts::local_dir(&state)?;
    let emitter = app.clone();
    let entries = open_vault_in(&state.session, local_dir, &path, move |paths| {
        // Fails only once the app is shutting down; nobody is listening.
        let _ = emitter.emit(CHANGED_EVENT, Changed { paths });
    })?;
    // DocsApp still boots from last_vault until U9; B4 removes this write.
    let _ = settings_store::write(&app, &[SettingsSection::Vault], |s| {
        s.last_vault = Some(path);
        s.vault_prompted = true;
    });
    Ok(entries)
}

/// Opens `path` as the one vault of the session. It writes no setting: the
/// vault list in the registry says which vaults exist, and the UI keeps the
/// source it showed last.
fn open_vault_in(
    session: &Shared,
    local_dir: &Path,
    path: &str,
    on_changed: impl Fn(Vec<String>) + Send + 'static,
) -> Result<Vec<DocEntry>, CmdError> {
    Ok(session.open(local_dir, Path::new(path), on_changed)?)
}

#[tauri::command(async)]
pub fn last_vault(app: AppHandle) -> Option<String> {
    settings_store::read(&app).last_vault
}

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct VaultSetup {
    prompt: bool,
    default_path: String,
}

#[tauri::command(async)]
pub fn vault_setup(app: AppHandle) -> VaultSetup {
    let saved = settings_store::read(&app);
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .ok();
    VaultSetup {
        prompt: !saved.vault_prompted && saved.last_vault.is_none(),
        default_path: base
            .map(|dir| dir.join("xDev").display().to_string())
            .unwrap_or_default(),
    }
}

/// Like `open_vault`, a lost save only means the offer shows once more.
#[tauri::command(async)]
pub fn dismiss_vault_prompt(app: AppHandle) {
    let _ = settings_store::write(&app, &[SettingsSection::Vault], |s| s.vault_prompted = true);
}

/// Settings → Git as stored; the defaults when nothing is.
#[tauri::command(async)]
pub fn git_settings(app: AppHandle) -> settings::GitSettings {
    load_git_settings(&app)
}

pub(crate) fn load_git_settings(app: &AppHandle) -> settings::GitSettings {
    settings_store::read(app).git
}

/// Stores Settings → Git with the custom prefix normalized, and returns
/// what was stored. An unusable prefix is kept; creating a worktree with it
/// is what fails.
#[tauri::command(async)]
pub fn set_git_settings(
    app: AppHandle,
    git: settings::GitSettings,
) -> Result<settings::GitSettings, CmdError> {
    settings_store::write(&app, &[SettingsSection::Git], |s| s.git = git.normalized())
        .map(|s| s.git)
}

/// Settings → Terminal as stored, clamped so a hand-edited file never reaches xterm out of
/// range; the defaults when nothing is stored.
#[tauri::command(async)]
pub fn terminal_settings_get(app: AppHandle) -> settings::TerminalSettings {
    settings_store::read(&app).terminal.clamped()
}

/// Stores Settings → Terminal with every number clamped to its range, and
/// returns what was stored.
#[tauri::command(async)]
pub fn terminal_settings_put(
    app: AppHandle,
    settings: settings::TerminalSettings,
) -> Result<settings::TerminalSettings, CmdError> {
    settings_store::write(&app, &[SettingsSection::Terminal], |s| {
        s.terminal = settings.clamped()
    })
    .map(|s| s.terminal)
}

/// Settings → Shortcuts: the terminal policy and the hint toggle; the
/// defaults when nothing is stored.
#[tauri::command(async)]
pub fn key_settings_get(app: AppHandle) -> settings::KeySettings {
    settings_store::read(&app).keys
}

/// Stores the key settings and returns what was stored.
#[tauri::command(async)]
pub fn key_settings_put(
    app: AppHandle,
    settings: settings::KeySettings,
) -> Result<settings::KeySettings, CmdError> {
    settings_store::write(&app, &[SettingsSection::Keys], |s| s.keys = settings).map(|s| s.keys)
}

/// The window's view settings (zoom, restore, theme); the defaults when nothing is stored.
#[tauri::command(async)]
pub fn ui_settings_get(app: AppHandle) -> settings::UiSettings {
    settings_store::read(&app).ui
}

/// Stores the view settings with the zoom clamped, and returns what was
/// stored.
#[tauri::command(async)]
pub fn ui_settings_put(
    app: AppHandle,
    settings: settings::UiSettings,
) -> Result<settings::UiSettings, CmdError> {
    let ui = settings_store::write(&app, &[SettingsSection::Ui], |s| s.ui = settings.clamped())
        .map(|s| s.ui)?;
    crate::window_chrome::apply(&app, ui.titlebar);
    Ok(ui)
}

/// Settings → Editor as stored; the defaults when nothing is.
#[tauri::command(async)]
pub fn editor_settings_get(app: AppHandle) -> settings::EditorSettings {
    settings_store::read(&app).editor
}

/// Stores Settings → Editor with every number clamped to its range, and
/// returns what was stored.
#[tauri::command(async)]
pub fn editor_settings_put(
    app: AppHandle,
    settings: settings::EditorSettings,
) -> Result<settings::EditorSettings, CmdError> {
    settings_store::write(&app, &[SettingsSection::Editor], |s| {
        s.editor = settings.clamped()
    })
    .map(|s| s.editor)
}

/// The sidebar's filters as stored; all off when nothing is.
#[tauri::command(async)]
pub fn sidebar_prefs_get(app: AppHandle) -> settings::SidebarPrefs {
    settings_store::read(&app).sidebar
}

/// Stores the sidebar's filters and returns what was stored.
#[tauri::command(async)]
pub fn sidebar_prefs_put(
    app: AppHandle,
    prefs: settings::SidebarPrefs,
) -> Result<settings::SidebarPrefs, CmdError> {
    settings_store::write(&app, &[SettingsSection::Sidebar], |s| {
        s.sidebar = prefs.clamped()
    })
    .map(|s| s.sidebar)
}

/// Settings → General → Navigation as stored; the defaults when nothing is.
#[tauri::command(async)]
pub fn navigation_settings_get(app: AppHandle) -> settings::NavigationSettings {
    settings_store::read(&app).navigation
}

/// Stores Settings → General → Navigation and returns what was stored.
#[tauri::command(async)]
pub fn navigation_settings_put(
    app: AppHandle,
    settings: settings::NavigationSettings,
) -> Result<settings::NavigationSettings, CmdError> {
    settings_store::write(&app, &[SettingsSection::Navigation], |s| {
        s.navigation = settings
    })
    .map(|s| s.navigation)
}

/// Settings → General → Diff as stored; the defaults when nothing is.
#[tauri::command(async)]
pub fn diff_settings_get(app: AppHandle) -> settings::DiffSettings {
    settings_store::read(&app).diff
}

/// Stores Settings → General → Diff and returns what was stored.
#[tauri::command(async)]
pub fn diff_settings_put(
    app: AppHandle,
    settings: settings::DiffSettings,
) -> Result<settings::DiffSettings, CmdError> {
    settings_store::write(&app, &[SettingsSection::Diff], |s| s.diff = settings).map(|s| s.diff)
}

/// Settings → Agents as stored; the defaults when nothing is.
#[tauri::command(async)]
pub fn agents_settings_get(app: AppHandle) -> settings::AgentsSettings {
    settings_store::read(&app).agents
}

/// Stores Settings → Agents and returns what was stored.
#[tauri::command(async)]
pub fn agents_settings_put(
    app: AppHandle,
    settings: settings::AgentsSettings,
) -> Result<settings::AgentsSettings, CmdError> {
    crate::power::put_agents(&app, settings.clamped())
}

/// Settings → Automations as stored; the defaults when nothing is.
#[tauri::command(async)]
pub fn automations_settings_get(app: AppHandle) -> settings::AutomationsSettings {
    settings_store::read(&app).automations
}

/// Stores Settings → Automations and returns what was stored.
#[tauri::command(async)]
pub fn automations_settings_put(
    app: AppHandle,
    settings: settings::AutomationsSettings,
) -> Result<settings::AutomationsSettings, CmdError> {
    settings_store::write(&app, &[SettingsSection::Automations], |s| {
        s.automations = settings
    })
    .map(|s| s.automations)
}

/// Settings → Stats & Usage as stored; the defaults when nothing is.
#[tauri::command(async)]
pub fn usage_settings_get(app: AppHandle) -> settings::UsageSettings {
    settings_store::read(&app).usage
}

/// Stores Settings → Stats & Usage and returns what was stored. A cache
/// lifetime that is not one of the two known ones is stored as the short one.
#[tauri::command(async)]
pub fn usage_settings_put(
    app: AppHandle,
    settings: settings::UsageSettings,
) -> Result<settings::UsageSettings, CmdError> {
    let settings = settings.normalized();
    settings_store::write(&app, &[SettingsSection::Usage], |s| s.usage = settings).map(|s| s.usage)
}

/// Settings → General, Window and Updates groups as stored; the defaults
/// when nothing is.
#[tauri::command(async)]
pub fn shell_settings_get(app: AppHandle) -> settings::ShellSettings {
    settings_store::read(&app).shell
}

/// Stores the Window and Updates settings and returns what was stored. The
/// "still running in the tray" notice flag is kept from the stored value.
#[tauri::command(async)]
pub fn shell_settings_put(
    app: AppHandle,
    settings: settings::ShellSettings,
) -> Result<settings::ShellSettings, CmdError> {
    let stored = settings_store::write(&app, &[SettingsSection::Shell], |s| {
        s.shell = settings.for_put(&s.shell)
    })
    .map(|s| s.shell)?;
    // The tray follows the setting at once.
    crate::tray::sync(&app);
    Ok(stored)
}

/// The global git `user.name` that the git-username prefix shows; a repo's
/// own `user.name` wins when a worktree is created.
#[tauri::command(async)]
pub fn git_user_name() -> Option<String> {
    xdev_git::global_user_name().ok().flatten()
}

#[tauri::command(async)]
pub fn create_vault(path: String, file: String, content: String) -> Result<(), CmdError> {
    create_vault_at(Path::new(&path), &file, &content)
}

/// A folder that already has anything in it is the user's; only a fresh one
/// gets the starter doc.
pub(crate) fn create_vault_at(dir: &Path, file: &str, content: &str) -> Result<(), CmdError> {
    // `:` too, so `C:x.md` or an NTFS stream name cannot escape `dir`.
    if file.contains(['/', '\\', ':']) || file.len() <= ".md".len() || !file.ends_with(".md") {
        return Err(CmdError {
            code: "bad_path",
            detail: Some(file.to_owned()),
        });
    }
    let io_err = |e: std::io::Error| CmdError {
        code: "io",
        detail: Some(e.to_string()),
    };
    std::fs::create_dir_all(dir).map_err(io_err)?;
    if std::fs::read_dir(dir).map_err(io_err)?.next().is_none() {
        std::fs::write(dir.join(file), content).map_err(io_err)?;
    }
    Ok(())
}

#[tauri::command(async)]
pub fn list_docs(state: State<'_, AppState>) -> Result<Vec<DocEntry>, CmdError> {
    state.session.with(|s| s.list())
}

#[tauri::command(async)]
pub fn read_doc(state: State<'_, AppState>, path: String) -> Result<String, CmdError> {
    state.session.with(|s| s.read(&path))
}

#[tauri::command(async)]
pub fn write_doc(
    state: State<'_, AppState>,
    path: String,
    content: String,
) -> Result<(), CmdError> {
    state.session.with(|s| s.write(&path, &content))
}

#[tauri::command(async)]
pub fn create_doc(
    state: State<'_, AppState>,
    path: String,
    content: String,
) -> Result<(), CmdError> {
    state.session.with(|s| s.create(&path, &content))
}

/// Lets the UI print an MCP setup command that works without `xdev` on PATH.
#[tauri::command(async)]
pub fn cli_path() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    Some(cli_beside(&exe)?.display().to_string())
}

/// The installer ships the CLI next to the desktop exe.
pub(crate) fn cli_beside(exe: &Path) -> Option<PathBuf> {
    let cli = exe
        .parent()?
        .join(format!("xdev{}", std::env::consts::EXE_SUFFIX));
    cli.is_file().then_some(cli)
}

#[tauri::command(async)]
pub fn search(
    state: State<'_, AppState>,
    query: String,
    limit: usize,
) -> Result<Vec<SearchHit>, CmdError> {
    state.session.with(|s| s.search(&query, limit))
}

#[derive(serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct VcsState {
    /// The values `Shared::vcs_state` returns.
    #[cfg_attr(test, ts(type = r#""ok" | "no_repo" | "no_git""#))]
    status: &'static str,
}

#[tauri::command(async)]
pub fn vcs_state(state: State<'_, AppState>) -> Result<VcsState, CmdError> {
    Ok(VcsState {
        status: state.session.vcs_state()?,
    })
}

#[tauri::command(async)]
pub fn init_repo(state: State<'_, AppState>) -> Result<(), CmdError> {
    state.session.init_repo()
}

#[tauri::command(async)]
pub fn list_changes(state: State<'_, AppState>) -> Result<Vec<Change>, CmdError> {
    let r = state.session.review()?;
    Ok(xdev_core::list_changes(
        &r.vault, &r.repo, &r.written, &r.ai,
    )?)
}

#[tauri::command(async)]
pub fn read_base(state: State<'_, AppState>, path: String) -> Result<Option<String>, CmdError> {
    let r = state.session.review()?;
    Ok(xdev_core::read_base(&r.repo, &path)?)
}

#[tauri::command(async)]
pub fn approve(
    state: State<'_, AppState>,
    changes: Vec<xdev_core::Seen>,
    message: String,
) -> Result<Option<String>, CmdError> {
    let r = state.session.review()?;
    let id = xdev_core::approve(&r.vault, &r.repo, &r.written, &r.ai, &changes, &message)?;
    state.session.forget(&r, &seen_paths(&changes));
    Ok(id)
}

#[tauri::command(async)]
pub fn reject(state: State<'_, AppState>, changes: Vec<xdev_core::Seen>) -> Result<(), CmdError> {
    let r = state.session.review()?;
    xdev_core::reject(&r.vault, &r.repo, &r.written, &r.ai, &changes)?;
    state.session.forget(&r, &seen_paths(&changes));
    Ok(())
}

fn seen_paths(changes: &[xdev_core::Seen]) -> Vec<String> {
    changes.iter().map(|c| c.path.clone()).collect()
}

#[tauri::command(async)]
pub fn history(
    state: State<'_, AppState>,
    path: String,
    limit: usize,
) -> Result<Vec<Commit>, CmdError> {
    let r = state.session.review()?;
    Ok(xdev_core::history(&r.repo, &path, limit)?)
}

#[tauri::command(async)]
pub fn read_version(
    state: State<'_, AppState>,
    path: String,
    id: String,
) -> Result<Option<String>, CmdError> {
    let r = state.session.review()?;
    Ok(xdev_core::read_version(&r.repo, &path, &id)?)
}

#[tauri::command(async)]
pub fn restore_version(
    state: State<'_, AppState>,
    path: String,
    id: String,
) -> Result<(), CmdError> {
    state.session.restore_version(&path, &id)
}

#[tauri::command(async)]
pub fn backlinks(state: State<'_, AppState>, path: String) -> Result<Vec<DocLink>, CmdError> {
    state.session.with(|s| s.backlinks(&path))
}

/// Built per call from the registry, outside the session lock: a repo may be
/// added or renamed between two calls, and git is asked for each of them.
fn links_of(state: &AppState, vault: &Vault) -> Result<Links, CmdError> {
    let reg = Registry::load(data_dir(state)?)?;
    Ok(links_for(&reg, vault.root()))
}

#[tauri::command(async)]
pub fn doc_freshness(state: State<'_, AppState>, path: String) -> Result<Freshness, CmdError> {
    let (vault, repo) = state.session.freshness_source()?;
    let links = links_of(&state, &vault)?;
    Ok(xdev_core::freshness(&vault, repo.as_ref(), &links, &path)?)
}

#[tauri::command(async)]
pub fn stale_docs(state: State<'_, AppState>) -> Result<Vec<StaleDoc>, CmdError> {
    let (vault, repo) = state.session.freshness_source()?;
    let links = links_of(&state, &vault)?;
    Ok(xdev_core::stale_docs(&vault, repo.as_ref(), &links)?)
}

/// Outside the session lock: reading every doc and asking git for the repo
/// root must not stall typing.
fn export_vault(state: &AppState) -> Result<(Vault, PathBuf), CmdError> {
    let root = state.session.with(|s| Ok(s.vault_root()))?;
    let vault = Vault::open(&root).map_err(CoreError::from)?;
    let out = xdev_core::export_root(&vault)?;
    Ok((vault, out))
}

#[tauri::command(async)]
pub fn export_plan(state: State<'_, AppState>) -> Result<ExportPlan, CmdError> {
    let (vault, root) = export_vault(&state)?;
    Ok(xdev_core::export_plan(&vault, &root)?)
}

#[derive(serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Expected {
    path: String,
    hash: String,
}

#[tauri::command(async)]
pub fn export_write(
    state: State<'_, AppState>,
    expected: Vec<Expected>,
) -> Result<Vec<String>, CmdError> {
    let (vault, root) = export_vault(&state)?;
    let expected: Vec<(String, String)> = expected.into_iter().map(|e| (e.path, e.hash)).collect();
    let written = xdev_core::export_write(&vault, &root, &expected)?;
    if root == vault.root() {
        let docs: Vec<(String, String)> = written
            .iter()
            .filter(|p| xdev_core::is_doc_path(p))
            .filter_map(|p| Some((p.clone(), vault.read(p).ok()?)))
            .collect();
        state.session.with(|s| {
            for (path, content) in &docs {
                s.note_written(path, content);
            }
            Ok(())
        })?;
    }
    Ok(written)
}

pub(crate) fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    Some(dir.join(settings::FILE_NAME))
}

#[cfg(test)]
mod tests {
    use std::io;

    use xdev_core::{Store, StoreError, VaultError};

    use super::*;

    fn code_of(e: impl Into<CoreError>) -> &'static str {
        CmdError::from(e.into()).code
    }

    #[test]
    fn open_vault_leaves_the_last_vault_setting_alone() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("a.md"), "# A").unwrap();
        let store = settings_store::SettingsStore::new(data.path().join("settings.json"));
        store
            .update(|s| s.last_vault = Some("D:/elsewhere".into()))
            .unwrap();
        let before = store.read();

        let session = Shared::default();
        let path = root.path().to_string_lossy().into_owned();
        let entries = open_vault_in(&session, data.path(), &path, |_| {}).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(store.read(), before);
        assert_eq!(store.read().last_vault.as_deref(), Some("D:/elsewhere"));
    }

    #[test]
    fn cmd_error_maps_codes() {
        let x = || "x.md".to_owned();
        assert_eq!(code_of(VaultError::NotFound(x())), "not_found");
        assert_eq!(code_of(VaultError::OutsideVault(x())), "outside_vault");
        assert_eq!(code_of(VaultError::NotUtf8(x())), "not_utf8");
        assert_eq!(code_of(VaultError::TooLarge(x())), "too_large");
        assert_eq!(code_of(VaultError::Exists(x())), "exists");
        assert_eq!(code_of(VaultError::Io(io::Error::other("x"))), "io");
        assert_eq!(code_of(StoreError::Io(io::Error::other("x"))), "io");

        // A real SQLite failure, without depending on rusqlite here.
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("index.db");
        std::fs::write(&file, vec![0xAB; 4096]).unwrap();
        let err = Store::open(&file)
            .err()
            .expect("garbage file opened as a db");
        assert!(matches!(err, StoreError::Sqlite(_)), "{err:?}");
        assert_eq!(code_of(err), "io");

        assert_eq!(CmdError::no_vault().code, "no_vault");
    }

    #[test]
    fn cmd_error_serializes_like_the_ui_expects() {
        let json = serde_json::to_value(CmdError::from(CoreError::from(VaultError::NotFound(
            "x.md".into(),
        ))))
        .unwrap();
        assert_eq!(json["code"], "not_found");
        assert!(json["detail"].as_str().unwrap().contains("x.md"));

        let json = serde_json::to_value(CmdError::no_vault()).unwrap();
        assert_eq!(json, serde_json::json!({ "code": "no_vault" }));
    }

    #[test]
    fn create_vault_writes_starter_into_new_or_empty_dir() {
        let root = tempfile::tempdir().unwrap();
        let fresh = root.path().join("a").join("xDev");
        create_vault_at(&fresh, "Bắt đầu.md", "# Hi").unwrap();
        assert_eq!(
            std::fs::read_to_string(fresh.join("Bắt đầu.md")).unwrap(),
            "# Hi"
        );

        let empty = root.path().join("empty");
        std::fs::create_dir(&empty).unwrap();
        create_vault_at(&empty, "Getting started.md", "x").unwrap();
        assert!(empty.join("Getting started.md").is_file());
    }

    #[test]
    fn create_vault_leaves_a_used_dir_alone() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        create_vault_at(dir.path(), "Getting started.md", "x").unwrap();
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, [".git"]);
    }

    #[test]
    fn create_vault_rejects_bad_file_names() {
        let dir = tempfile::tempdir().unwrap();
        for file in [
            "../x.md", "a/b.md", "a\\b.md", "C:x.md", "x.txt", ".md", "..",
        ] {
            let err = create_vault_at(dir.path(), file, "x").unwrap_err();
            assert_eq!(err.code, "bad_path", "{file}");
        }
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn create_vault_over_a_file_is_io() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("xDev");
        std::fs::write(&file, "not a dir").unwrap();
        let err = create_vault_at(&file, "Getting started.md", "x").unwrap_err();
        assert_eq!(err.code, "io");
        assert!(err.detail.is_some());
    }

    #[test]
    fn cli_beside_finds_the_cli_only_when_present() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("xdev-desktop.exe");
        assert_eq!(cli_beside(&exe), None);

        let cli = dir
            .path()
            .join(format!("xdev{}", std::env::consts::EXE_SUFFIX));
        std::fs::write(&cli, "").unwrap();
        assert_eq!(cli_beside(&exe), Some(cli.clone()));

        // A folder with the CLI's name is not the CLI.
        std::fs::remove_file(&cli).unwrap();
        std::fs::create_dir(&cli).unwrap();
        assert_eq!(cli_beside(&exe), None);
    }

    #[test]
    fn vault_setup_serializes_like_the_ui_expects() {
        let setup = VaultSetup {
            prompt: true,
            default_path: "C:/Users/me/Documents/xDev".into(),
        };
        assert_eq!(
            serde_json::to_value(setup).unwrap(),
            serde_json::json!({ "prompt": true, "defaultPath": "C:/Users/me/Documents/xDev" })
        );
    }

    #[test]
    fn freshness_serializes_like_the_ui_expects() {
        let freshness = Freshness {
            state: xdev_core::DocState::Stale,
            covers: vec!["src/auth".into()],
            verified: Some("abc1234".into()),
            head: None,
            commits: vec![Commit {
                id: "f00d".into(),
                author: "A".into(),
                time: 1,
                message: "m".into(),
            }],
            count: 3,
        };
        assert_eq!(
            serde_json::to_value(freshness).unwrap(),
            serde_json::json!({
                "state": "stale", "covers": ["src/auth"], "verified": "abc1234", "head": null,
                "commits": [{ "id": "f00d", "author": "A", "time": 1, "message": "m" }], "count": 3
            })
        );
        let stale = StaleDoc {
            path: "a.md".into(),
            title: "A".into(),
            state: xdev_core::DocState::Unverified,
            count: 0,
        };
        assert_eq!(
            serde_json::to_value(stale).unwrap(),
            serde_json::json!({ "path": "a.md", "title": "A", "state": "unverified", "count": 0 })
        );
    }
}
