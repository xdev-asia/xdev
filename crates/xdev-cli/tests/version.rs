use std::process::Command;

#[test]
fn prints_version() {
    let out = Command::new(env!("CARGO_BIN_EXE_xdev"))
        .arg("--version")
        .output()
        .expect("run xdev");
    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "xdev 0.1.0");
}
