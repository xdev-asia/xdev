//! Embeds the build date for the perpetual Pro rule (D-R9): `XDEV_BUILD_DATE`, unix seconds.
//! `SOURCE_DATE_EPOCH` when it is set (reproducible builds), else the start of today (UTC).
//! The license reads it with `option_env!`; a missing value means "unknown".
//!
//! Declares the app commands (the `generate_handler!` list in `src/lib.rs`) so that each gets an
//! `allow-<command>` permission and a webview may call one only when a capability grants it:
//! `capabilities/default.json` (the main webview) and `capabilities/notch.json` (its two).

fn main() {
    println!("cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH");
    let epoch = std::env::var("SOURCE_DATE_EPOCH").ok();
    println!(
        "cargo:rustc-env=XDEV_BUILD_DATE={}",
        build_date(epoch.as_deref(), now())
    );
    println!("cargo:rerun-if-changed=src/lib.rs");
    let lib = std::fs::read_to_string("src/lib.rs").expect("read src/lib.rs");
    let commands: Vec<&'static str> = app_commands(&lib)
        .into_iter()
        .map(|c| &*Box::leak(c.into_boxed_str()))
        .collect();
    assert!(
        !commands.is_empty(),
        "no generate_handler! list in src/lib.rs"
    );
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(windows_attributes())
            .app_manifest(tauri_build::AppManifest::new().commands(commands.leak())),
    )
    .expect("tauri build");
}

/// The command names in the `generate_handler!` list of `lib_rs`, the last path segment of each,
/// in order and without repeats. `src/lib.rs` tests read the list the same way.
fn app_commands(lib_rs: &str) -> Vec<String> {
    let Some(start) = lib_rs.find("generate_handler![") else {
        return Vec::new();
    };
    let body = &lib_rs[start + "generate_handler![".len()..];
    let body = &body[..body.find(']').unwrap_or(body.len())];
    let mut names: Vec<String> = Vec::new();
    for path in body.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let name = path.rsplit("::").next().unwrap_or(path).to_owned();
        if !names.contains(&name) {
            names.push(name);
        }
    }
    names
}

/// On MSVC the Common Controls v6 manifest is linked into every binary of the crate, the lib test
/// harness too: tauri-build only puts it in the app binary, and without it the test exe stops at
/// load with STATUS_ENTRYPOINT_NOT_FOUND (comctl32 v6 entry points such as `TaskDialogIndirect`).
fn windows_attributes() -> tauri_build::WindowsAttributes {
    let windows = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
    let msvc = std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if !(windows && msvc) {
        return tauri_build::WindowsAttributes::new();
    }
    let manifest =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    tauri_build::WindowsAttributes::new_without_app_manifest()
}

/// Unix seconds of the build: the epoch when it parses to a positive number, else the start of
/// the day `now` falls on.
fn build_date(source_date_epoch: Option<&str>, now: i64) -> i64 {
    source_date_epoch
        .and_then(|s| s.trim().parse::<i64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(now - now.rem_euclid(86_400))
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_secs()).ok())
        .unwrap_or(0)
}
