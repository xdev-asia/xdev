use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use xdev_core::{
    CoreError, DocState, GitError, Links, Repo, Store, Vault, backlinks, freshness, is_doc_path,
    parse_frontmatter, propose_update, search, stale_docs, sync_vault,
};
use xdev_mcp::{
    ACTIVITY_FILE, ActivityEntry, ActivityLog, Doc, DocInfo, Docs, EndpointError, Hit, Host,
    SETTINGS_FILE, ToolError, ToolSettings,
};

/// Serves the vault on stdin/stdout until the client closes stdin.
pub fn run(vault: Vault, mut store: Store) -> Result<(), &'static str> {
    // Synced before the first request so a client that only calls get_doc
    // still sees titles and backlinks.
    sync_vault(&vault, &mut store).map_err(|e| e.code())?;
    let mut docs = CoreDocs { vault, store };
    let mut host = AppHost::from_env();
    xdev_mcp::serve_with(
        &mut docs,
        &mut host,
        io::stdin().lock(),
        io::stdout().lock(),
        xdev_core::version(),
    )
    .map_err(|_| "io")
}

struct CoreDocs {
    vault: Vault,
    store: Store,
}

fn tool_error(e: impl Into<CoreError>) -> ToolError {
    ToolError {
        code: e.into().code().to_owned(),
    }
}

fn state_name(state: DocState) -> &'static str {
    match state {
        DocState::None => "none",
        DocState::Fresh => "fresh",
        DocState::Stale => "stale",
        DocState::Unverified => "unverified",
        DocState::Unknown => "unknown",
        DocState::Unlinked => "unlinked",
    }
}

impl CoreDocs {
    fn sync(&mut self) -> Result<(), ToolError> {
        sync_vault(&self.vault, &mut self.store).map_err(tool_error)?;
        Ok(())
    }

    /// Looked up per call: `git init` while the server runs should count.
    /// Without git, reads still work and covered docs are `unknown`.
    fn repo(&self) -> Result<Option<Repo>, ToolError> {
        match Repo::discover(self.vault.root()) {
            Ok(repo) => Ok(Some(repo)),
            Err(GitError::NoRepo | GitError::NoGit) => Ok(None),
            Err(e) => Err(tool_error(e)),
        }
    }

    fn titles(&self) -> Result<HashMap<String, String>, ToolError> {
        Ok(self
            .store
            .docs()
            .map_err(tool_error)?
            .into_iter()
            .map(|d| (d.path, d.title))
            .collect())
    }

    fn info(&self, repo: Option<&Repo>, path: &str, title: String) -> Result<DocInfo, ToolError> {
        let content = self.vault.read(path).map_err(tool_error)?;
        let fm = parse_frontmatter(&content).0;
        // Docs without `covers` skip git entirely; listing a large vault
        // should not cost a process per doc.
        let (state, count) = if fm.covers.is_empty() {
            (DocState::None, 0)
        } else {
            let f = freshness(&self.vault, repo, &Links::default(), path).map_err(tool_error)?;
            (f.state, f.count)
        };
        Ok(DocInfo {
            path: path.to_owned(),
            title,
            doc_type: fm.doc_type,
            state: state_name(state).to_owned(),
            covers: fm.covers,
            count,
        })
    }
}

impl Docs for CoreDocs {
    fn context_pack(
        &mut self,
        query: &str,
        budget: usize,
    ) -> Result<xdev_core::ContextPack, ToolError> {
        self.sync()?;
        crate::context::pack(&self.vault, &self.store, query, budget)
            .map_err(|code| ToolError { code: code.into() })
    }

    fn vault_name(&self) -> String {
        let root = self.vault.root().display().to_string();
        root.trim_start_matches(r"\\?\").to_owned()
    }

    fn search(&mut self, query: &str, limit: usize) -> Result<Vec<Hit>, ToolError> {
        self.sync()?;
        Ok(search(&self.store, query, limit)
            .map_err(tool_error)?
            .into_iter()
            .map(|h| Hit {
                path: h.path,
                title: h.title,
                snippet: h.snippet,
            })
            .collect())
    }

    fn get(&mut self, path: &str) -> Result<Doc, ToolError> {
        // `Vault::read` takes any file inside the vault; agents get docs only.
        if !is_doc_path(path) {
            return Err(ToolError {
                code: "outside_vault".to_owned(),
            });
        }
        self.sync()?;
        let content = self.vault.read(path).map_err(tool_error)?;
        let title = self.titles()?.remove(path).unwrap_or_default();
        let repo = self.repo()?;
        let info = self.info(repo.as_ref(), path, title)?;
        let backlinks = backlinks(&self.vault, &self.store, path)
            .map_err(tool_error)?
            .into_iter()
            .map(|l| l.path)
            .collect();
        Ok(Doc {
            info,
            content,
            backlinks,
        })
    }

    fn list(&mut self, doc_type: Option<&str>) -> Result<Vec<DocInfo>, ToolError> {
        self.sync()?;
        let repo = self.repo()?;
        let mut out = Vec::new();
        for doc in self.store.docs().map_err(tool_error)? {
            // A doc removed since the sync is skipped, as the index will.
            let Ok(info) = self.info(repo.as_ref(), &doc.path, doc.title) else {
                continue;
            };
            if doc_type.is_none_or(|t| info.doc_type.as_deref() == Some(t)) {
                out.push(info);
            }
        }
        Ok(out)
    }

    fn stale(&mut self) -> Result<Vec<DocInfo>, ToolError> {
        self.sync()?;
        let repo = self.repo()?;
        let mut out = Vec::new();
        for doc in stale_docs(&self.vault, repo.as_ref(), &Links::default()).map_err(tool_error)? {
            let content = self.vault.read(&doc.path).map_err(tool_error)?;
            let fm = parse_frontmatter(&content).0;
            out.push(DocInfo {
                path: doc.path,
                title: doc.title,
                doc_type: fm.doc_type,
                state: state_name(doc.state).to_owned(),
                covers: fm.covers,
                count: doc.count,
            });
        }
        Ok(out)
    }

    fn propose(
        &mut self,
        path: &str,
        content: &str,
        summary: Option<&str>,
    ) -> Result<(), ToolError> {
        // Without git there is no review to wait in, so nothing is written.
        let repo = Repo::discover(self.vault.root()).map_err(tool_error)?;
        propose_update(&self.vault, &repo, &mut self.store, path, content, summary)
            .map_err(tool_error)?;
        self.sync()
    }
}

/// The running app and the person's switches, as the app tools see them.
/// Everything is looked up per request: the app may start or quit, and the
/// switches change, while this process lives.
struct AppHost {
    /// `mcp-tools.json` in the app's config folder.
    settings: Option<PathBuf>,
    /// `mcp-activity.json` in the local folder.
    activity: Option<PathBuf>,
    /// Where the app's endpoint lives.
    endpoint_dir: Option<PathBuf>,
    /// The terminal this server was started from, so the app knows the caller.
    pty: Option<String>,
}

impl AppHost {
    fn from_env() -> AppHost {
        let local = xdev_core::local_dir();
        AppHost {
            settings: xdev_core::config_dir().map(|d| d.join(SETTINGS_FILE)),
            activity: local.as_ref().map(|d| d.join(ACTIVITY_FILE)),
            endpoint_dir: local.map(|d| xdev_ipc::app_dir(&d)),
            pty: std::env::var("XDEV_PTY_ID").ok().filter(|p| !p.is_empty()),
        }
    }
}

fn read_settings(path: Option<&Path>) -> ToolSettings {
    path.and_then(|p| fs::read_to_string(p).ok())
        .map(|text| ToolSettings::parse(&text))
        .unwrap_or_default()
}

/// Adds `entry` to the log at `path`, keeping the newest 200. Written to a
/// temp file and renamed so a reader never sees half a file; two servers
/// logging at the same instant may lose one entry, which the log accepts.
fn append_activity(path: &Path, entry: ActivityEntry) -> io::Result<()> {
    let mut log = fs::read_to_string(path)
        .map(|text| ActivityLog::parse(&text))
        .unwrap_or_default();
    log.push(entry);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    fs::write(&tmp, log.to_json())?;
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

fn call_app(
    dir: Option<&Path>,
    pty: Option<&str>,
    method: &str,
    params: Value,
) -> Result<Value, EndpointError> {
    let fail = |e: crate::app::AppError| EndpointError {
        code: e.code,
        message: e.message,
    };
    let dir = dir.ok_or_else(|| EndpointError {
        code: "io".into(),
        message: "no local folder".into(),
    })?;
    let limit = crate::app::answer_limit(method, &params);
    let mut client = crate::app::Client::connect(dir, crate::app::PREFIX, pty).map_err(fail)?;
    client.call(method, params, limit).map_err(fail)
}

impl Host for AppHost {
    fn enabled(&self, tool: &str) -> bool {
        read_settings(self.settings.as_deref()).enabled(tool)
    }

    fn call(&mut self, method: &str, params: Value) -> Result<Value, EndpointError> {
        call_app(
            self.endpoint_dir.as_deref(),
            self.pty.as_deref(),
            method,
            params,
        )
    }

    fn now_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
    }

    fn record(&mut self, entry: ActivityEntry) {
        if let Some(path) = &self.activity {
            // A log that cannot be written must not fail the tool call.
            let _ = append_activity(path, entry);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(n: u64) -> ActivityEntry {
        ActivityEntry {
            at_ms: n,
            tool: "list_ports".into(),
            ok: true,
            duration_ms: 3,
        }
    }

    #[test]
    fn the_log_file_grows_to_200_and_stops() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub").join(ACTIVITY_FILE);
        for n in 0..205 {
            append_activity(&path, entry(n)).unwrap();
        }
        let log = ActivityLog::parse(&fs::read_to_string(&path).unwrap());
        assert_eq!(log.entries.len(), 200);
        assert_eq!(log.entries[0].at_ms, 5);
        // No temp file is left behind.
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn switches_come_from_the_file_and_default_without_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SETTINGS_FILE);
        assert!(read_settings(Some(&path)).enabled("list_tabs"));
        assert!(!read_settings(None).enabled("send_to_tab"));
        fs::write(&path, r#"{"tools":{"send_to_tab":true,"list_tabs":false}}"#).unwrap();
        let s = read_settings(Some(&path));
        assert!(s.enabled("send_to_tab") && !s.enabled("list_tabs"));
        fs::write(&path, "garbage").unwrap();
        assert!(read_settings(Some(&path)).enabled("list_tabs"));
    }

    #[test]
    fn without_an_app_the_error_code_is_app_not_running() {
        let dir = tempfile::tempdir().unwrap();
        let e = call_app(Some(dir.path()), None, "status", Value::Null).unwrap_err();
        assert_eq!(e.code, "app_not_running");
        assert_eq!(
            call_app(None, None, "status", Value::Null)
                .unwrap_err()
                .code,
            "io"
        );
    }
}
