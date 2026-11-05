//! The real machine, read-only: this test's own listener must show up.

use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::time::Duration;

use xdev_ports::{OsProbe, Probe};

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
fn terminate_ends_a_child_and_forgives_one_that_is_gone() {
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
    OsProbe.terminate(pid).unwrap();
}
