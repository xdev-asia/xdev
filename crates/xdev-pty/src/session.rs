//! One process in a pseudo console, with its input, output and size.

use std::ffi::OsString;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, mpsc};
use std::thread;

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use xdev_ai::process::kill_tree;
use xdev_ai::shim;

use crate::pump::{Flow, WINDOW, pump};

/// Batch shims get their command line through this variable; see `command`.
const SHIM_LINE: &str = "XDEV_SHIM_LINE";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, OsString)>,
    pub cwd: PathBuf,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, thiserror::Error)]
pub enum PtyError {
    #[error("could not start the terminal: {0}")]
    Spawn(String),
    #[error("argument not allowed for a batch file")]
    BadArg,
    #[error("could not resize the terminal: {0}")]
    Resize(String),
}

impl PtyError {
    /// Stable code the UI translates.
    pub fn code(&self) -> &'static str {
        match self {
            PtyError::Spawn(_) => "pty_spawn",
            PtyError::BadArg => "bad_arg",
            PtyError::Resize(_) => "pty_resize",
        }
    }
}

pub struct Session {
    master: Mutex<Box<dyn MasterPty + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    pid: Option<u32>,
    input: mpsc::Sender<Vec<u8>>,
    flow: Arc<Flow>,
    stop: Arc<AtomicBool>,
    exited: Arc<AtomicBool>,
}

impl Session {
    pub fn spawn(
        spec: SpawnSpec,
        on_output: impl FnMut(Vec<u8>) + Send + 'static,
        on_exit: impl FnOnce(Option<i32>) + Send + 'static,
    ) -> Result<Session, PtyError> {
        Session::spawn_with_window(spec, WINDOW, on_output, on_exit)
    }

    /// Like `spawn`, reading paused once `window` bytes wait for an ack. The
    /// service passes `usize::MAX`: its ring takes every byte, so a child
    /// whose client is away never blocks on a full console.
    pub fn spawn_with_window(
        spec: SpawnSpec,
        window: usize,
        on_output: impl FnMut(Vec<u8>) + Send + 'static,
        on_exit: impl FnOnce(Option<i32>) + Send + 'static,
    ) -> Result<Session, PtyError> {
        let cmd = command(&spec)?;
        let pair = native_pty_system()
            .openpty(size(spec.cols, spec.rows))
            .map_err(spawn_error)?;
        let mut child = pair.slave.spawn_command(cmd).map_err(spawn_error)?;
        // Only the child holds the slave now, so its exit closes the console.
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().map_err(spawn_error)?;
        let mut writer = pair.master.take_writer().map_err(spawn_error)?;

        let flow = Arc::new(Flow::with_window(window));
        let stop = Arc::new(AtomicBool::new(false));
        {
            let (flow, stop) = (flow.clone(), stop.clone());
            thread::spawn(move || pump(reader, flow, stop, on_output));
        }
        // Writes queue here, so a child that is not reading never blocks
        // the caller (the UI thread).
        let (input, queued) = mpsc::channel::<Vec<u8>>();
        thread::spawn(move || {
            for data in queued {
                if writer
                    .write_all(&data)
                    .and_then(|()| writer.flush())
                    .is_err()
                {
                    break;
                }
            }
        });
        let pid = child.process_id();
        let killer = child.clone_killer();
        let exited = Arc::new(AtomicBool::new(false));
        {
            let exited = exited.clone();
            thread::spawn(move || {
                let code = child.wait().ok().map(|s| s.exit_code() as i32);
                exited.store(true, Ordering::SeqCst);
                on_exit(code);
            });
        }
        Ok(Session {
            master: Mutex::new(pair.master),
            killer: Mutex::new(killer),
            pid,
            input,
            flow,
            stop,
            exited,
        })
    }

    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    pub fn write(&self, data: Vec<u8>) {
        // A closed queue means the child is gone; there is nobody to tell.
        let _ = self.input.send(data);
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), PtyError> {
        lock(&self.master)
            .resize(size(cols, rows))
            .map_err(|e| PtyError::Resize(e.to_string()))
    }

    pub fn ack(&self, n: usize) {
        self.flow.ack(n);
    }

    pub fn kill(&self) {
        // After the child has exited its pid may belong to someone else.
        if self.stop.swap(true, Ordering::SeqCst) || self.exited.load(Ordering::SeqCst) {
            return;
        }
        // The tree first: Windows finds it by parent id, which needs the
        // child still alive.
        if let Some(pid) = self.pid {
            kill_tree(pid);
        }
        let _ = lock(&self.killer).kill();
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.kill();
    }
}

/// `cmd.exe` re-parses a batch file's command line, and the pseudo console
/// quotes each argument with backslashes, which `cmd` does not read. So the
/// line goes in a variable: `cmd` expands it before it splits on `&` and
/// quotes, and nothing in it can expand again (`shim::line` refuses `%`/`!`).
fn command(spec: &SpawnSpec) -> Result<CommandBuilder, PtyError> {
    let mut cmd = if cfg!(windows) && shim::is_batch(&spec.program) {
        let line = shim::line(&spec.program, &spec.args).map_err(|_| PtyError::BadArg)?;
        let mut cmd = CommandBuilder::new("cmd.exe");
        cmd.args(["/d", "/c", &format!("%{SHIM_LINE}%")]);
        cmd.env(SHIM_LINE, line);
        cmd
    } else {
        let mut cmd = CommandBuilder::new(&spec.program);
        cmd.args(&spec.args);
        cmd
    };
    if !spec.env.iter().any(|(k, _)| k == "TERM") {
        cmd.env("TERM", "xterm-256color");
    }
    for (key, value) in &spec.env {
        cmd.env(key, value);
    }
    cmd.cwd(&spec.cwd);
    Ok(cmd)
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn spawn_error(e: impl std::fmt::Display) -> PtyError {
    PtyError::Spawn(e.to_string())
}

fn lock<T: ?Sized>(m: &Mutex<Box<T>>) -> MutexGuard<'_, Box<T>> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}
