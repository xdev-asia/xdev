const MANIFEST: &str = include_str!("../Cargo.toml");

#[test]
fn core_does_not_depend_on_tauri() {
    let mut in_deps = false;
    for line in MANIFEST.lines().map(str::trim) {
        if line.starts_with('[') {
            in_deps = line.contains("dependencies");
            continue;
        }
        assert!(
            !(in_deps && line.starts_with("tauri")),
            "xdev-core must not depend on tauri: {line}"
        );
    }
}

#[test]
fn version_is_workspace_version() {
    assert_eq!(xdev_core::version(), env!("CARGO_PKG_VERSION"));
}
