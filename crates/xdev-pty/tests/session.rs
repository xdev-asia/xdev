//! Real pseudo consoles: each test starts a process and waits on its output.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use xdev_pty::{Session, SpawnSpec};

const DEADLINE: Duration = Duration::from_secs(10);

/// A session plus everything it has printed so far.
struct Run {
    session: Arc<Session>,
    out: Arc<Mutex<Vec<u8>>>,
    exit: mpsc::Receiver<Option<i32>>,
}

impl Run {
    fn start(program: impl Into<PathBuf>, args: &[&str]) -> Run {
        let out = Arc::new(Mutex::new(Vec::new()));
        let (tx, exit) = mpsc::channel();
        // The pseudo console may ask for the cursor position before it
        // prints anything; the UI terminal answers that, so the test does too.
        let answer: Arc<Mutex<Option<Arc<Session>>>> = Arc::default();
        let sink = {
            let out = out.clone();
            let answer = answer.clone();
            move |bytes: Vec<u8>| {
                if bytes.windows(4).any(|w| w == b"\x1b[6n") {
                    if let Some(s) = answer.lock().unwrap().as_ref() {
                        s.write(b"\x1b[1;1R".to_vec());
                    }
                }
                out.lock().unwrap().extend(bytes);
            }
        };
        let spec = SpawnSpec {
            program: program.into(),
            args: args.iter().map(|a| a.to_string()).collect(),
            env: Vec::new(),
            cwd: std::env::temp_dir(),
            cols: 80,
            rows: 24,
        };
        let session = Arc::new(
            Session::spawn(spec, sink, move |code| {
                let _ = tx.send(code);
            })
            .unwrap(),
        );
        *answer.lock().unwrap() = Some(session.clone());
        // The query may have arrived before the session existed.
        if String::from_utf8_lossy(&out.lock().unwrap()).contains("\x1b[6n") {
            session.write(b"\x1b[1;1R".to_vec());
        }
        Run { session, out, exit }
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.out.lock().unwrap()).into_owned()
    }

    fn wait_until(&self, what: &str, done: impl Fn(&str) -> bool) -> String {
        let start = Instant::now();
        loop {
            let text = self.text();
            if done(&text) {
                return text;
            }
            assert!(start.elapsed() < DEADLINE, "no {what} in {text:?}");
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn wait_for(&self, needle: &str) -> String {
        self.wait_until(needle, |t| t.contains(needle))
    }
}

/// `script` as one command line for the platform shell.
fn sh(script: &str) -> Run {
    if cfg!(windows) {
        Run::start("cmd.exe", &["/d", "/c", script])
    } else {
        Run::start("/bin/sh", &["-c", script])
    }
}

fn powershell(script: &str) -> Run {
    Run::start(
        "powershell.exe",
        &[
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ],
    )
}

fn alive(pid: u32) -> bool {
    if cfg!(windows) {
        let out = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
    } else {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success()
    }
}

#[test]
fn echo_round_trip() {
    let run = if cfg!(windows) {
        Run::start("cmd.exe", &["/d", "/q"])
    } else {
        Run::start("/bin/sh", &[])
    };
    run.session.write(b"echo xdev-ok\r".to_vec());
    // The typed line echoes too; the second copy is the command's output.
    run.wait_until("printed xdev-ok", |t| t.matches("xdev-ok").count() >= 2);
}

#[test]
fn ten_kb_paste_arrives_whole() {
    let run = if cfg!(windows) {
        powershell("$l = [Console]::In.ReadLine(); [Console]::Out.WriteLine('LEN=' + $l.Length)")
    } else {
        // A cooked tty line stops at 4 KB.
        sh("stty -icanon; IFS= read -r l; echo LEN=${#l}")
    };
    let mut paste = vec![b'a'; 10_240];
    paste.push(b'\r');
    run.session.write(paste);
    run.wait_for("LEN=10240");
}

#[test]
fn write_does_not_block_when_child_is_not_reading() {
    let run = if cfg!(windows) {
        sh("ping -n 6 127.0.0.1 >nul")
    } else {
        sh("sleep 5")
    };
    let start = Instant::now();
    run.session.write(vec![b'x'; 1024 * 1024]);
    assert!(start.elapsed() < Duration::from_millis(50));
}

#[test]
fn resize_is_seen_by_child() {
    let run = if cfg!(windows) {
        sh("ping -n 3 127.0.0.1 >nul & mode con")
    } else {
        sh("sleep 1; stty size")
    };
    run.session.resize(100, 40).unwrap();
    if cfg!(windows) {
        let text = run.wait_for("Columns:");
        let line = text.lines().find(|l| l.contains("Columns:")).unwrap();
        assert!(line.contains("100"), "{line:?}");
    } else {
        run.wait_for("40 100");
    }
}

#[test]
fn exit_code_reported() {
    let run = sh("exit 3");
    assert_eq!(run.exit.recv_timeout(DEADLINE).unwrap(), Some(3));
}

#[test]
fn kill_reaches_grandchild() {
    let run = if cfg!(windows) {
        powershell(
            "$p = Start-Process -FilePath ping -ArgumentList '-n','30','127.0.0.1' \
             -NoNewWindow -PassThru; [Console]::Out.WriteLine('PID=' + $p.Id + ';'); \
             $p.WaitForExit()",
        )
    } else {
        sh("sleep 30 & echo \"PID=$!;\"; wait")
    };
    let text = run.wait_until("a pid", |t| {
        t.split("PID=").nth(1).is_some_and(|r| r.contains(';'))
    });
    let pid: u32 = text
        .split("PID=")
        .nth(1)
        .and_then(|rest| rest.split(';').next())
        .and_then(|digits| digits.trim().parse().ok())
        .unwrap_or_else(|| panic!("no pid in {text:?}"));
    assert!(alive(pid));
    run.session.kill();
    let start = Instant::now();
    while alive(pid) {
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "grandchild {pid} lives"
        );
        thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(windows)]
#[test]
fn batch_shim_gets_args_whole() {
    let dir = tempfile::tempdir().unwrap();
    let fake = dir.path().join("fake.cmd");
    std::fs::write(&fake, "@echo ARGS=%*\r\n").unwrap();
    let run = Run::start(fake, &["a b", "x&y"]);
    run.wait_for(r#"ARGS="a b" "x&y""#);
}
