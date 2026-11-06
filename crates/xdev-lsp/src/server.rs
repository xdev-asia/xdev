//! One language server process: spawn without a shell, the `initialize`
//! handshake, the capabilities it answered, and a polite stop.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::io::{BufReader, BufWriter, Read};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use url::Url;

use crate::LspError;
use crate::conn::{Connection, OnClose, OnNotify};

/// How long `initialize` may take; a cold server indexes first.
pub const INIT_TIMEOUT: Duration = Duration::from_secs(20);
/// How long `shutdown` may take, and then how long the exit may take.
pub const STOP_TIMEOUT: Duration = Duration::from_secs(2);
/// How much of the server's stderr is kept.
pub const STDERR_KEEP: usize = 64 * 1024;

/// The part of the server's capabilities the app uses.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ServerCaps {
    pub hover: bool,
    pub completion: bool,
    pub trigger_characters: Vec<String>,
    pub definition: bool,
    pub rename: bool,
    pub prepare_rename: bool,
    pub workspace_symbol: bool,
    /// 0 none, 1 full, 2 incremental. The client always sends full text.
    pub sync: u8,
}

/// A provider is on when it is `true` or an options object.
fn provided(v: &Value) -> bool {
    v.as_bool().unwrap_or_else(|| v.is_object())
}

impl ServerCaps {
    /// From an `initialize` result.
    pub fn from_init(result: &Value) -> ServerCaps {
        let caps = &result["capabilities"];
        let rename = &caps["renameProvider"];
        let sync = &caps["textDocumentSync"];
        ServerCaps {
            hover: provided(&caps["hoverProvider"]),
            completion: provided(&caps["completionProvider"]),
            trigger_characters: caps["completionProvider"]["triggerCharacters"]
                .as_array()
                .map(|all| {
                    all.iter()
                        .filter_map(|c| c.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default(),
            definition: provided(&caps["definitionProvider"]),
            rename: provided(rename),
            prepare_rename: rename["prepareProvider"].as_bool() == Some(true),
            workspace_symbol: provided(&caps["workspaceSymbolProvider"]),
            sync: sync
                .as_u64()
                .or_else(|| sync["change"].as_u64())
                .and_then(|k| u8::try_from(k).ok())
                .unwrap_or(0),
        }
    }
}

/// The `initialize` params: one workspace folder, the capability subset the
/// app handles, UTF-16 positions.
pub fn init_params(worktree: &Path) -> Value {
    let root = Url::from_directory_path(worktree)
        .map(|u| Value::String(u.into()))
        .unwrap_or(Value::Null);
    let name = worktree
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    json!({
        "processId": std::process::id(),
        "clientInfo": {"name": "xDev", "version": env!("CARGO_PKG_VERSION")},
        "rootUri": root,
        "workspaceFolders": [{"uri": root, "name": name}],
        "capabilities": {
            "general": {"positionEncodings": ["utf-16"]},
            "textDocument": {
                "synchronization": {"dynamicRegistration": false, "willSave": false, "didSave": false},
                "hover": {"contentFormat": ["markdown", "plaintext"]},
                "completion": {
                    "completionItem": {"snippetSupport": false, "insertReplaceSupport": true},
                    "completionList": {"itemDefaults": ["editRange"]},
                },
                "definition": {"linkSupport": true},
                "rename": {"prepareSupport": true},
                "publishDiagnostics": {"relatedInformation": false},
            },
            "workspace": {
                "symbol": {},
                "workspaceFolders": true,
                "configuration": true,
            },
        },
    })
}

/// The last bytes a stream wrote.
#[derive(Default)]
struct Tail(VecDeque<u8>);

impl Tail {
    fn push(&mut self, bytes: &[u8]) {
        self.0.extend(bytes);
        let over = self.0.len().saturating_sub(STDERR_KEEP);
        self.0.drain(..over);
    }
}

pub struct Server {
    conn: Connection,
    child: Option<Mutex<Child>>,
    caps: ServerCaps,
    stderr: Arc<Mutex<Tail>>,
    program: String,
}

impl Server {
    /// Starts `program` in `worktree` and runs the handshake. `path_env`
    /// replaces PATH for the server when set. `on_close` runs once when its
    /// output ends, whatever the reason.
    pub fn spawn(
        program: &Path,
        args: &[&str],
        worktree: &Path,
        path_env: Option<OsString>,
        on_notify: OnNotify,
        on_close: OnClose,
    ) -> Result<Server, LspError> {
        let mut cmd = Command::new(program);
        cmd.args(args)
            .current_dir(worktree)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(path) = path_env {
            cmd.env("PATH", path);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| LspError::Spawn(e.kind().to_string()))?;
        let (Some(stdin), Some(stdout), Some(mut stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(LspError::Spawn("no pipes".into()));
        };
        let tail = Arc::new(Mutex::new(Tail::default()));
        let sink = tail.clone();
        let _ = thread::Builder::new()
            .name("lsp-stderr".into())
            .spawn(move || {
                let mut buf = [0u8; 4096];
                while let Ok(n) = stderr.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    sink.lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .push(&buf[..n]);
                }
            });
        let conn = Connection::start_with_close(
            BufReader::new(stdout),
            BufWriter::new(stdin),
            on_notify,
            on_close,
        );
        let name = program
            .file_stem()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        Server::handshake(conn, Some(child), tail, worktree, name)
    }

    /// The handshake over a connection with no process, for tests.
    pub fn over(conn: Connection, worktree: &Path, program: &str) -> Result<Server, LspError> {
        Server::handshake(conn, None, Arc::default(), worktree, program.to_owned())
    }

    fn handshake(
        conn: Connection,
        child: Option<Child>,
        stderr: Arc<Mutex<Tail>>,
        worktree: &Path,
        program: String,
    ) -> Result<Server, LspError> {
        let mut server = Server {
            conn,
            child: child.map(Mutex::new),
            caps: ServerCaps::default(),
            stderr,
            program,
        };
        // On failure `server` drops, which kills the process.
        let result = server
            .conn
            .request("initialize", init_params(worktree), INIT_TIMEOUT)?;
        server.conn.notify("initialized", json!({}))?;
        server.caps = ServerCaps::from_init(&result);
        Ok(server)
    }

    pub fn caps(&self) -> &ServerCaps {
        &self.caps
    }

    /// The program's name, without its directory: what logs may show.
    pub fn program(&self) -> &str {
        &self.program
    }

    pub fn is_closed(&self) -> bool {
        self.conn.is_closed()
    }

    pub fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, LspError> {
        self.conn.request(method, params, timeout)
    }

    pub fn notify(&self, method: &str, params: Value) -> Result<(), LspError> {
        self.conn.notify(method, params)
    }

    /// The last of what the server wrote to stderr.
    pub fn stderr_tail(&self) -> String {
        let tail = self.stderr.lock().unwrap_or_else(PoisonError::into_inner);
        let (a, b) = tail.0.as_slices();
        String::from_utf8_lossy(&[a, b].concat()).into_owned()
    }

    /// `shutdown`, `exit`, then a kill if the process is still there after
    /// two seconds.
    pub fn stop(&self) {
        if !self.conn.is_closed() {
            let _ = self.conn.request("shutdown", Value::Null, STOP_TIMEOUT);
            let _ = self.conn.notify("exit", Value::Null);
        }
        let Some(child) = &self.child else { return };
        let mut child = child.lock().unwrap_or_else(PoisonError::into_inner);
        let deadline = Instant::now() + STOP_TIMEOUT;
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) | Err(_) => return,
                Ok(None) => thread::sleep(Duration::from_millis(50)),
            }
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        if let Some(child) = &self.child {
            let mut child = child.lock().unwrap_or_else(PoisonError::into_inner);
            if let Ok(None) = child.try_wait() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::framing::{read_message, write_message};
    use std::io::pipe;
    use std::sync::mpsc;

    #[test]
    fn caps_from_init_shapes() {
        let caps = ServerCaps::from_init(&json!({"capabilities": {
            "hoverProvider": true,
            "completionProvider": {"triggerCharacters": [".", ":"]},
            "definitionProvider": {"workDoneProgress": false},
            "renameProvider": {"prepareProvider": true},
            "workspaceSymbolProvider": false,
            "textDocumentSync": {"openClose": true, "change": 2},
        }}));
        assert_eq!(
            caps,
            ServerCaps {
                hover: true,
                completion: true,
                trigger_characters: vec![".".into(), ":".into()],
                definition: true,
                rename: true,
                prepare_rename: true,
                workspace_symbol: false,
                sync: 2,
            }
        );
        let bare = ServerCaps::from_init(
            &json!({"capabilities": {"renameProvider": true, "textDocumentSync": 1}}),
        );
        assert!(bare.rename && !bare.prepare_rename && !bare.hover);
        assert_eq!(bare.sync, 1);
        assert_eq!(ServerCaps::from_init(&Value::Null), ServerCaps::default());
    }

    #[test]
    fn init_params_name_the_client_and_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("my repo");
        let p = init_params(&root);
        assert_eq!(p["clientInfo"]["name"], "xDev");
        let uri = p["rootUri"].as_str().unwrap();
        assert!(
            uri.starts_with("file://") && uri.ends_with("my%20repo/"),
            "{uri}"
        );
        assert_eq!(p["workspaceFolders"][0]["uri"], uri);
        assert_eq!(p["workspaceFolders"][0]["name"], "my repo");
        let caps = &p["capabilities"];
        assert_eq!(caps["general"]["positionEncodings"], json!(["utf-16"]));
        assert_eq!(
            caps["textDocument"]["completion"]["completionItem"]["snippetSupport"],
            false
        );
        assert_eq!(caps["textDocument"]["definition"]["linkSupport"], true);
        assert_eq!(caps["textDocument"]["rename"]["prepareSupport"], true);
        assert_eq!(caps["workspace"]["configuration"], true);
    }

    #[test]
    fn the_tail_keeps_the_last_bytes() {
        let mut t = Tail::default();
        t.push(&vec![b'a'; STDERR_KEEP]);
        t.push(b"end");
        assert_eq!(t.0.len(), STDERR_KEEP);
        assert_eq!(
            t.0.iter().rev().take(3).copied().collect::<Vec<_>>(),
            b"dne"
        );
    }

    #[test]
    fn handshake_then_stop_over_pipes() {
        let (client_in, mut server_out) = pipe().unwrap();
        let (server_in, client_out) = pipe().unwrap();
        let (seen_tx, seen_rx) = mpsc::channel();
        let fake = thread::spawn(move || {
            let mut from = BufReader::new(server_in);
            while let Ok(Some(msg)) = read_message(&mut from) {
                let method = msg["method"].as_str().unwrap_or_default().to_owned();
                let _ = seen_tx.send(method.clone());
                let result = match method.as_str() {
                    "initialize" => json!({"capabilities": {"hoverProvider": true}}),
                    "shutdown" => Value::Null,
                    "exit" => break,
                    _ => continue,
                };
                write_message(
                    &mut server_out,
                    &json!({"jsonrpc": "2.0", "id": msg["id"], "result": result}),
                )
                .unwrap();
            }
        });
        let conn = Connection::start(BufReader::new(client_in), client_out, Box::new(|_, _| {}));
        let dir = tempfile::tempdir().unwrap();
        let server = Server::over(conn, dir.path(), "fake").unwrap();
        assert!(server.caps().hover);
        assert!(!server.caps().completion);
        assert_eq!(server.program(), "fake");
        server.stop();
        fake.join().unwrap();
        let seen: Vec<_> = seen_rx.try_iter().collect();
        assert_eq!(seen, ["initialize", "initialized", "shutdown", "exit"]);
    }

    #[test]
    fn a_server_that_closes_during_the_handshake_fails() {
        let (client_in, server_out) = pipe().unwrap();
        let (_server_in, client_out) = pipe().unwrap();
        drop(server_out);
        let conn = Connection::start(BufReader::new(client_in), client_out, Box::new(|_, _| {}));
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            Server::over(conn, dir.path(), "fake"),
            Err(LspError::Closed | LspError::Io(_))
        ));
    }

    /// Starts the real rust-analyzer when it is installed.
    #[test]
    #[ignore = "starts a real language server"]
    fn a_real_rust_analyzer_starts_and_stops() {
        let Some(program) = xdev_agent::find_program("rust-analyzer") else {
            eprintln!("rust-analyzer is not installed");
            return;
        };
        // A toolchain proxy without the component is on the PATH but exits.
        let runs = Command::new(&program)
            .arg("--version")
            .output()
            .is_ok_and(|o| o.status.success());
        if !runs {
            eprintln!("rust-analyzer does not run");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("Cargo.toml"),
            "[package]\nname = \"probe\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )
        .unwrap();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/lib.rs"), "pub fn probe() {}\n").unwrap();
        let (closed_tx, closed_rx) = mpsc::channel();
        let server = Server::spawn(
            &program,
            &[],
            dir.path(),
            xdev_agent::path_override(),
            Box::new(|_, _| {}),
            Box::new(move || {
                let _ = closed_tx.send(());
            }),
        )
        .unwrap();
        assert!(server.caps().hover);
        assert!(server.caps().definition);
        assert_eq!(server.program(), "rust-analyzer");
        server.stop();
        closed_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    }
}
