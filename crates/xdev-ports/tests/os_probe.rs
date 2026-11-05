//! The real machine: this test's own listener must show up, and a stop ends
//! a whole tree this test started. Only 127.0.0.1 is bound.

use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use xdev_ports::urls::AdvertisedUrls;
use xdev_ports::{OsProbe, Probe, Proc, PtyRoot, Scanner, StopConsent};

#[test]
fn the_probe_lists_a_socket_this_test_opened() {
    let socket = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = socket.local_addr().unwrap().port();
    let found = OsProbe.listeners(Duration::from_secs(4)).unwrap();
    let mine = found.iter().find(|l| l.port == port).expect("own port");
    assert_eq!(mine.pid, Some(std::process::id()));
    let procs = OsProbe.processes().unwrap();
    assert!(procs.iter().any(|p| p.pid == std::process::id()));
}

#[test]
// No second signal after `wait()`: the pid is free again and may name another process.
fn terminate_ends_a_child() {
    let mut child = if cfg!(windows) {
        let mut c = Command::new("ping");
        c.args(["-n", "30", "127.0.0.1"]);
        c
    } else {
        let mut c = Command::new("sleep");
        c.arg("30");
        c
    }
    .stdout(Stdio::null())
    .spawn()
    .unwrap();
    let pid = child.id();
    OsProbe.terminate(pid).unwrap();
    child.wait().unwrap();
}

/// Which part of the tree this test binary plays when it runs itself.
const ROLE: &str = "XDEV_PORTS_TREE_ROLE";

fn spawn_self(role: &str, stdout: Stdio) -> Child {
    Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "tree_helper", "--nocapture", "--test-threads=1"])
        .env(ROLE, role)
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

/// Not a test of its own: the parts of the tree the stop test starts. The
/// "terminal" starts a "server", which listens and starts a "worker".
#[test]
fn tree_helper() {
    let wait = || std::thread::sleep(Duration::from_secs(60));
    match std::env::var(ROLE).as_deref() {
        Ok("terminal") => {
            // Reaps the server once it is stopped, then stays like a shell.
            let _ = spawn_self("server", Stdio::inherit()).wait();
            wait();
        }
        Ok("server") => {
            // Held open until the process ends.
            let socket = TcpListener::bind("127.0.0.1:0").unwrap();
            let mut worker = spawn_self("worker", Stdio::null());
            let port = socket.local_addr().unwrap().port();
            println!("PORT {port} WORKER {}", worker.id());
            let _ = worker.wait();
            drop(socket);
        }
        Ok("worker") => wait(),
        _ => {}
    }
}

/// Ends the whole tree when the test ends, even by a panic. A signal stops
/// one pid, so the tree this test started is walked here, through the
/// links `Proc::is_parent_of` accepts.
struct Tree(Child);

impl Drop for Tree {
    fn drop(&mut self) {
        let procs = OsProbe.processes().unwrap_or_default();
        let mut tree: Vec<&Proc> = procs.iter().filter(|p| p.pid == self.0.id()).collect();
        let mut i = 0;
        while i < tree.len() {
            let parent = tree[i];
            for p in &procs {
                if parent.is_parent_of(p) && !tree.iter().any(|t| t.pid == p.pid) {
                    tree.push(p);
                }
            }
            i += 1;
        }
        for p in tree.iter().skip(1) {
            let _ = OsProbe.kill(p.pid);
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Whether `pid` has ended; a zombie waiting for its parent counts.
fn ended(pid: u32) -> bool {
    if cfg!(windows) {
        return OsProbe
            .processes()
            .is_ok_and(|ps| ps.iter().all(|p| p.pid != pid));
    }
    let out = Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let stat = String::from_utf8_lossy(&out.stdout);
    stat.trim().is_empty() || stat.trim_start().starts_with('Z')
}

#[test]
fn stop_ends_the_listener_and_its_children_and_reports_the_port_closed() {
    let mut terminal = spawn_self("terminal", Stdio::piped());
    let out = terminal.stdout.take().unwrap();
    let tree = Tree(terminal);
    let line = BufReader::new(out)
        .lines()
        .map_while(Result::ok)
        .find_map(|l| l.find("PORT ").map(|at| l[at..].to_owned()))
        .expect("the server says its port");
    // The test runner may print its own words before it on the same line.
    let words: Vec<&str> = line.split_whitespace().collect();
    let port: u16 = words[1].parse().unwrap();
    let worker: u32 = words[3].parse().unwrap();

    let dir = tempfile::tempdir().unwrap();
    let worktree = PathBuf::from(dir.path());
    let roots = [PtyRoot {
        pid: tree.0.id(),
        worktree: worktree.clone(),
    }];
    let worktrees = [worktree];
    let urls = Mutex::new(AdvertisedUrls::default());
    let scanner = Scanner::new(OsProbe, Instant::now);
    let scan = scanner.scan(&roots, &worktrees, &urls, true);
    let id = scan
        .ports
        .iter()
        .find(|p| p.port == port)
        .expect("the scan lists the server")
        .id
        .clone();

    let once = StopConsent {
        confirmed: true,
        outside_terminal: false,
    };
    let after = scanner
        .stop(&id, once, &roots, &worktrees, &urls, &[std::process::id()])
        .expect("the stop succeeds");
    assert!(after.ports.iter().all(|p| p.port != port));
    let found = OsProbe.listeners(Duration::from_secs(4)).unwrap();
    assert!(found.iter().all(|l| l.port != port));

    // The worker under the server ended with it.
    let deadline = Instant::now() + Duration::from_secs(5);
    while !ended(worker) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(ended(worker), "worker {worker} still runs");
    // The terminal above the server was left alone.
    assert!(!ended(tree.0.id()));
}
