//! A private `CODEX_HOME` per codex account, owned by xDev, that carries the
//! status hooks: codex has no per-process flag for hooks, and nothing may be
//! written to the person's own codex folder (R3, R15).
//!
//! `<data_dir>/codex-home/<account or default>/` holds:
//! - `hooks.json`: the `xdev agent-hook` commands;
//! - `config.toml`: the real home's config, plus `[features] hooks = true`
//!   and a trust entry per hook;
//! - `auth.json`: a hard link to the real one, checked before each launch
//!   and linked again when broken. Its content is never read;
//! - `sessions`: a link to the real `sessions` folder, so `codex resume` and
//!   history see every session.
//!
//! The real home is only read (`config.toml`) and linked to; it is never
//! written.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

use crate::version::CliVersion;

/// The folder under the data dir that holds the private homes.
pub const CODEX_HOME_DIR: &str = "codex-home";

/// The first codex that gets the private home (the reference app's minimum).
pub const CODEX_HOOKS_SINCE: CliVersion = CliVersion(0, 136, 0);

/// The first codex with the `Interrupt` event (per the reference app).
/// [Unverified] on older versions: not tested how codex treats an unknown
/// event in `hooks.json`, so it is left out there.
pub const CODEX_INTERRUPT_SINCE: CliVersion = CliVersion(0, 150, 0);

/// How long a codex hook may run, in seconds. Codex clamps `Interrupt` to 3
/// and warns at every launch when it is set higher.
const CODEX_TIMEOUT: u64 = 10;
const INTERRUPT_TIMEOUT: u64 = 3;

/// One codex hook: its `hooks.json` event, the snake_case label of its trust
/// key and hash, and the `xdev agent-hook` event it writes.
struct CodexHook {
    event: &'static str,
    label: &'static str,
    writes: &'static str,
    timeout: u64,
}

const CODEX_HOOKS: [CodexHook; 5] = [
    CodexHook {
        event: "UserPromptSubmit",
        label: "user_prompt_submit",
        writes: "prompt",
        timeout: CODEX_TIMEOUT,
    },
    CodexHook {
        event: "PermissionRequest",
        label: "permission_request",
        writes: "needs-input",
        timeout: CODEX_TIMEOUT,
    },
    CodexHook {
        event: "PostToolUse",
        label: "post_tool_use",
        writes: "resume",
        timeout: CODEX_TIMEOUT,
    },
    CodexHook {
        event: "Stop",
        label: "stop",
        writes: "turn-done",
        timeout: CODEX_TIMEOUT,
    },
    CodexHook {
        event: "Interrupt",
        label: "interrupt",
        writes: "interrupt",
        timeout: INTERRUPT_TIMEOUT,
    },
];

fn offered(version: CliVersion) -> impl Iterator<Item = &'static CodexHook> {
    CODEX_HOOKS
        .iter()
        .filter(move |h| h.event != "Interrupt" || version >= CODEX_INTERRUPT_SINCE)
}

/// The private home of `account` (`None`: the system default codex).
pub fn private_codex_home(data_dir: &Path, account: Option<&str>) -> PathBuf {
    let name = match account {
        // Account names are `[a-z0-9-]`, so they are folder names already;
        // `default` is kept for the default home.
        Some("default") => "account-default",
        Some(name) => name,
        None => "default",
    };
    data_dir.join(CODEX_HOME_DIR).join(name)
}

/// Builds or refreshes the private home of `account` for a codex at
/// `version` whose own home is `real_home`, with hooks that run `xdev`.
/// Returns the folder to pass as `CODEX_HOME`.
///
/// Fails, so the caller falls back to `notify`, when the codex is older than
/// [`CODEX_HOOKS_SINCE`], the real home has no `auth.json` (a home without
/// it would ask the person to log in again), the real `config.toml` does not
/// parse or `auth.json` cannot be hard linked (another drive).
pub fn prepare_codex_home(
    data_dir: &Path,
    account: Option<&str>,
    real_home: &Path,
    xdev: &Path,
    version: CliVersion,
) -> io::Result<PathBuf> {
    if version < CODEX_HOOKS_SINCE {
        return Err(other("codex too old for hooks"));
    }
    let home = private_codex_home(data_dir, account);
    if same_place(real_home, &data_dir.join(CODEX_HOME_DIR)) {
        return Err(other("CODEX_HOME is already a private home"));
    }
    let real_auth = real_home.join("auth.json");
    if !real_auth.is_file() {
        return Err(other("no auth.json in the codex home"));
    }
    fs::create_dir_all(&home)?;
    let home = dunce(&home);
    let hooks_path = home.join("hooks.json");
    let hooks = codex_hooks_json(xdev, version);
    let config = codex_config(real_home, &home, &hooks_path, xdev, version)?;
    write_atomic(&hooks_path, &hooks)?;
    write_atomic(&home.join("config.toml"), &config)?;
    link_auth(&real_auth, &home.join("auth.json"))?;
    // History is nice to have: a failed bridge leaves sessions private.
    let _ = bridge_sessions(&real_home.join("sessions"), &home.join("sessions"));
    Ok(home)
}

/// The `hooks.json` of the private home.
pub fn codex_hooks_json(xdev: &Path, version: CliVersion) -> String {
    let mut hooks = serde_json::Map::new();
    for hook in offered(version) {
        hooks.insert(
            hook.event.to_owned(),
            serde_json::json!([{ "hooks": [{
                "type": "command",
                "command": hook_command(xdev, hook.writes),
                "timeout": hook.timeout,
            }] }]),
        );
    }
    let mut text =
        serde_json::to_string_pretty(&serde_json::json!({ "hooks": hooks })).unwrap_or_default();
    text.push('\n');
    text
}

/// The command line a codex hook runs. On Windows a path of only
/// `[A-Za-z0-9_.:/~-]` goes bare with `/` separators (it runs as it is
/// under PowerShell and `cmd /c`); any other path goes through
/// `cmd.exe --% /d /v:off /c @"path"`, the reference app's form.
/// [Unverified] the `cmd.exe` form was not run in the spike.
/// Elsewhere the path is a single-quoted shell word.
pub fn hook_command(xdev: &Path, event: &str) -> String {
    let path = xdev.to_string_lossy();
    if cfg!(windows) {
        let slashed = path.replace('\\', "/");
        let bare = slashed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_.:/~-".contains(c));
        if bare {
            format!("{slashed} agent-hook {event}")
        } else {
            format!(r#"C:\Windows\System32\cmd.exe --% /d /v:off /c @"{path}" agent-hook {event}"#)
        }
    } else {
        format!("'{}' agent-hook {event}", path.replace('\'', r"'\''"))
    }
}

/// The trust hash codex keeps for a hook: `sha256:` and the hex sha256 of
/// the hook's definition as JSON with sorted keys and no spaces,
/// `{"event_name":…,"hooks":[{"async":false,"command":…,"timeout":…,"type":"command"}]}`
/// (no matcher: none of these hooks has one).
///
/// Ported from the reference app's description, not its code or test
/// vectors. [Unverified] against codex 0.129, 0.140 and 0.159.3: the
/// vectors were not available, and that `event_name` is the snake_case
/// label is a guess. A wrong hash makes codex skip the hook; `notify` still
/// reports the end of a turn then.
pub fn trust_hash(label: &str, command: &str, timeout: u64) -> String {
    let quote = |s: &str| serde_json::to_string(s).unwrap_or_default();
    let canonical = format!(
        r#"{{"event_name":{},"hooks":[{{"async":false,"command":{},"timeout":{timeout},"type":"command"}}]}}"#,
        quote(label),
        quote(command),
    );
    let digest = Sha256::digest(canonical.as_bytes());
    let mut hex = String::with_capacity(71);
    hex.push_str("sha256:");
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// The trust keys of the hook at group 0, handler 0 of `label`: the
/// `hooks.json` path, then `:<label>:0:0`. On Windows both the `\` and `/`
/// forms of the path, as the reference app writes them. [Unverified] how
/// codex normalizes the path (drive letter case).
fn trust_keys(hooks_path: &Path, label: &str) -> Vec<String> {
    let path = hooks_path.to_string_lossy();
    let mut keys = vec![format!("{path}:{label}:0:0")];
    if cfg!(windows) {
        let slashed = format!("{}:{label}:0:0", path.replace('\\', "/"));
        if !keys.contains(&slashed) {
            keys.push(slashed);
        }
    }
    keys
}

/// The private `config.toml`: the real one (when there is one), with
/// `[features] hooks = true` and the trust entries set. Project trust that
/// codex wrote into the private copy (`[projects]`) is kept, so a folder is
/// not asked about again at each launch.
fn codex_config(
    real_home: &Path,
    home: &Path,
    hooks_path: &Path,
    xdev: &Path,
    version: CliVersion,
) -> io::Result<String> {
    let mut config = read_toml(&real_home.join("config.toml"))?.unwrap_or_default();
    if let Ok(Some(private)) = read_toml(&home.join("config.toml"))
        && let Some(toml::Value::Table(projects)) = private.get("projects")
    {
        let mine = config
            .entry("projects")
            .or_insert_with(|| toml::Value::Table(toml::Table::new()));
        if let toml::Value::Table(mine) = mine {
            for (key, value) in projects {
                mine.entry(key.clone()).or_insert_with(|| value.clone());
            }
        }
    }
    let features = table_at(&mut config, "features");
    // `codex_hooks` is the name deprecated since codex 0.133.
    features.remove("codex_hooks");
    features.insert("hooks".to_owned(), toml::Value::Boolean(true));
    let hooks = table_at(&mut config, "hooks");
    let state = table_at(hooks, "state");
    for hook in offered(version) {
        let command = hook_command(xdev, hook.writes);
        let mut entry = toml::Table::new();
        entry.insert("enabled".to_owned(), toml::Value::Boolean(true));
        entry.insert(
            "trusted_hash".to_owned(),
            toml::Value::String(trust_hash(hook.label, &command, hook.timeout)),
        );
        for key in trust_keys(hooks_path, hook.label) {
            state.insert(key, toml::Value::Table(entry.clone()));
        }
    }
    toml::to_string(&config).map_err(other)
}

/// The table at `key`, made (or made a table) when it is not one.
fn table_at<'a>(table: &'a mut toml::Table, key: &str) -> &'a mut toml::Table {
    let value = table
        .entry(key)
        .or_insert_with(|| toml::Value::Table(toml::Table::new()));
    if !value.is_table() {
        *value = toml::Value::Table(toml::Table::new());
    }
    match value {
        toml::Value::Table(t) => t,
        _ => unreachable!("just made a table"),
    }
}

/// `None` when the file is missing; an error when it does not parse.
fn read_toml(path: &Path) -> io::Result<Option<toml::Table>> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    toml::from_str(&text).map(Some).map_err(other)
}

/// Makes `link` a hard link to `real` unless it already is one. A file that
/// is no longer the same (codex replaced it, say on a token refresh) is kept
/// as `auth.json.unlinked-<ms>`, never deleted, and the link is made again.
/// Neither file is opened for its content.
fn link_auth(real: &Path, link: &Path) -> io::Result<()> {
    match fs::symlink_metadata(link) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return fs::hard_link(real, link),
        Err(e) => return Err(e),
        Ok(_) => {}
    }
    if is_linked(real, link)? {
        return Ok(());
    }
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    fs::rename(
        link,
        link.with_file_name(format!("auth.json.unlinked-{ms}")),
    )?;
    fs::hard_link(real, link)
}

/// Whether `link` is still a hard link to `real`: the same file, so it has
/// at least two names. The count is not required to be exactly 2: a third
/// name (a link in the Recycle Bin, a backup) is not a broken link, and
/// re-linking would not lower it, so every launch would re-link again.
fn is_linked(real: &Path, link: &Path) -> io::Result<bool> {
    let (a, links) = file_id(link)?;
    let (b, _) = file_id(real)?;
    Ok(a == b && links >= 2)
}

/// A file's identity (volume or device, index or inode) and link count.
#[cfg(windows)]
fn file_id(path: &Path) -> io::Result<((u64, u64), u64)> {
    use std::os::windows::fs::OpenOptionsExt;
    // No read or write access: only the file's information is asked for.
    let file = fs::OpenOptions::new().access_mode(0).open(path)?;
    let info = winapi_util::file::information(&file)?;
    Ok((
        (info.volume_serial_number(), info.file_index()),
        info.number_of_links(),
    ))
}

#[cfg(unix)]
fn file_id(path: &Path) -> io::Result<((u64, u64), u64)> {
    use std::os::unix::fs::MetadataExt;
    let meta = fs::metadata(path)?;
    Ok(((meta.dev(), meta.ino()), meta.nlink()))
}

#[cfg(not(any(windows, unix)))]
fn file_id(_path: &Path) -> io::Result<((u64, u64), u64)> {
    Err(io::Error::from(io::ErrorKind::Unsupported))
}

/// Points the private `sessions` at the real one: a junction on Windows
/// (no admin or developer mode needed), else a symlink. Nothing is made in
/// the real home, and a private `sessions` that codex already filled is
/// left alone.
fn bridge_sessions(real: &Path, link: &Path) -> io::Result<()> {
    if !real.is_dir() || fs::symlink_metadata(link).is_ok() {
        return Ok(());
    }
    #[cfg(windows)]
    {
        if junction(real, link).is_ok() && link.is_dir() {
            return Ok(());
        }
        std::os::windows::fs::symlink_dir(real, link)
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(real, link)
    }
    #[cfg(not(any(windows, unix)))]
    {
        Err(io::Error::from(io::ErrorKind::Unsupported))
    }
}

#[cfg(windows)]
fn junction(real: &Path, link: &Path) -> io::Result<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let status = std::process::Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(link)
        .arg(real)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(other("mklink /J failed"))
    }
}

/// Writes `text` through a temporary file in the same folder, so codex never
/// reads a half-written file.
fn write_atomic(path: &Path, text: &str) -> io::Result<()> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = path.with_file_name(format!(
        ".{name}-{}-{}.tmp",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    fs::write(&tmp, text)?;
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

/// `path` made absolute, without the `\\?\` prefix `canonicalize` adds on
/// Windows (codex's trust keys use plain paths).
fn dunce(path: &Path) -> PathBuf {
    let Ok(full) = fs::canonicalize(path) else {
        return path.to_path_buf();
    };
    let text = full.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => full,
    }
}

/// Whether `inner` is `outer` or inside it, comparing real paths.
fn same_place(inner: &Path, outer: &Path) -> bool {
    match (fs::canonicalize(inner), fs::canonicalize(outer)) {
        (Ok(inner), Ok(outer)) => inner.starts_with(outer),
        _ => false,
    }
}

fn other(e: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> io::Error {
    io::Error::other(e)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NEW: CliVersion = CliVersion(0, 165, 0);

    /// A real codex home in a temp dir: an `auth.json`, a `config.toml` and
    /// a `sessions` folder.
    fn real_home(root: &Path) -> PathBuf {
        let real = root.join("real-codex");
        fs::create_dir_all(real.join("sessions").join("2026")).unwrap();
        fs::write(real.join("auth.json"), "{\"fake\":true}").unwrap();
        fs::write(
            real.join("config.toml"),
            "model = \"gpt-x\"\n\n[features]\ncodex_hooks = true\n\n[mcp_servers.docs]\ncommand = \"docs\"\n",
        )
        .unwrap();
        fs::write(real.join("sessions").join("2026").join("a.jsonl"), "{}\n").unwrap();
        real
    }

    /// Every path under `dir` with its file content, for "left untouched".
    fn snapshot(dir: &Path) -> Vec<(String, Vec<u8>)> {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            for entry in fs::read_dir(&d).unwrap() {
                let path = entry.unwrap().path();
                let rel = path
                    .strip_prefix(dir)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                if path.is_dir() {
                    out.push((rel, Vec::new()));
                    stack.push(path);
                } else {
                    out.push((rel, fs::read(&path).unwrap()));
                }
            }
        }
        out.sort();
        out
    }

    fn xdev(root: &Path) -> PathBuf {
        root.join("bin").join("xdev")
    }

    #[test]
    fn private_home_is_per_account_under_the_data_dir() {
        let data = Path::new("/data");
        assert_eq!(
            private_codex_home(data, None),
            data.join("codex-home").join("default")
        );
        assert_eq!(
            private_codex_home(data, Some("work")),
            data.join("codex-home").join("work")
        );
        assert_ne!(
            private_codex_home(data, Some("default")),
            private_codex_home(data, None)
        );
    }

    #[test]
    fn hooks_json_maps_the_events_and_gates_interrupt() {
        let x = Path::new("/opt/xdev");
        let parse =
            |v| -> serde_json::Value { serde_json::from_str(&codex_hooks_json(x, v)).unwrap() };
        let new = parse(NEW);
        let events: Vec<&String> = new["hooks"].as_object().unwrap().keys().collect();
        let mut want = [
            "Interrupt",
            "PermissionRequest",
            "PostToolUse",
            "Stop",
            "UserPromptSubmit",
        ];
        want.sort();
        let mut got: Vec<&str> = events.iter().map(|s| s.as_str()).collect();
        got.sort();
        assert_eq!(got, want);
        let handler = |v: &serde_json::Value, e: &str| v["hooks"][e][0]["hooks"][0].clone();
        assert_eq!(handler(&new, "Interrupt")["timeout"], 3);
        assert_eq!(handler(&new, "Stop")["timeout"], 10);
        assert_eq!(handler(&new, "Stop")["type"], "command");
        assert!(
            handler(&new, "PermissionRequest")["command"]
                .as_str()
                .unwrap()
                .ends_with("agent-hook needs-input")
        );
        assert!(new["hooks"]["Stop"][0].get("matcher").is_none());

        let old = parse(CliVersion(0, 149, 9));
        assert!(old["hooks"].get("Interrupt").is_none());
        assert!(old["hooks"].get("Stop").is_some());
    }

    #[test]
    #[cfg(windows)]
    fn windows_command_is_bare_only_for_plain_paths() {
        assert_eq!(
            hook_command(Path::new(r"C:\Tools\xdev.exe"), "prompt"),
            "C:/Tools/xdev.exe agent-hook prompt"
        );
        assert_eq!(
            hook_command(Path::new(r"C:\Program Files\xDev\xdev.exe"), "stop"),
            r#"C:\Windows\System32\cmd.exe --% /d /v:off /c @"C:\Program Files\xDev\xdev.exe" agent-hook stop"#
        );
    }

    #[test]
    #[cfg(unix)]
    fn unix_command_is_one_shell_word() {
        assert_eq!(
            hook_command(Path::new("/opt/it's/xdev"), "prompt"),
            r"'/opt/it'\''s/xdev' agent-hook prompt"
        );
    }

    #[test]
    fn trust_hash_hashes_the_canonical_definition() {
        // Fixed by sha256 itself, not by codex: [Unverified] against codex.
        let canonical = r#"{"event_name":"stop","hooks":[{"async":false,"command":"/x agent-hook turn-done","timeout":10,"type":"command"}]}"#;
        let want: String = Sha256::digest(canonical.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(
            trust_hash("stop", "/x agent-hook turn-done", 10),
            format!("sha256:{want}")
        );
        assert_ne!(
            trust_hash("stop", "/x agent-hook turn-done", 10),
            trust_hash("stop", "/y agent-hook turn-done", 10)
        );
        // A quote in the command is JSON-escaped, not left raw.
        assert_ne!(
            trust_hash("stop", "a\"b", 10),
            trust_hash("stop", "a\\\"b", 10)
        );
    }

    #[test]
    fn prepare_builds_the_home_and_leaves_the_real_one_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        let real = real_home(tmp.path());
        let before = snapshot(&real);

        let home = prepare_codex_home(&data, Some("work"), &real, &xdev(tmp.path()), NEW).unwrap();
        assert!(home.starts_with(dunce(&data)));
        assert_eq!(home.file_name().unwrap(), "work");

        let config: toml::Table =
            toml::from_str(&fs::read_to_string(home.join("config.toml")).unwrap()).unwrap();
        assert_eq!(config["model"].as_str(), Some("gpt-x"));
        assert!(config["mcp_servers"]["docs"].is_table());
        assert_eq!(config["features"]["hooks"].as_bool(), Some(true));
        assert!(config["features"].get("codex_hooks").is_none());
        let state = config["hooks"]["state"].as_table().unwrap();
        let hooks_path = home.join("hooks.json").to_string_lossy().into_owned();
        let forms = if cfg!(windows) { 2 } else { 1 };
        assert_eq!(state.len(), 5 * forms);
        let stop = &state[&format!("{hooks_path}:stop:0:0")];
        assert_eq!(stop["enabled"].as_bool(), Some(true));
        let command = hook_command(&xdev(tmp.path()), "turn-done");
        assert_eq!(
            stop["trusted_hash"].as_str().unwrap(),
            trust_hash("stop", &command, 10)
        );
        if cfg!(windows) {
            let slashed = format!("{}:interrupt:0:0", hooks_path.replace('\\', "/"));
            assert_eq!(
                state[&slashed]["trusted_hash"].as_str().unwrap(),
                trust_hash(
                    "interrupt",
                    &hook_command(&xdev(tmp.path()), "interrupt"),
                    3
                )
            );
        }

        assert!(is_linked(&real.join("auth.json"), &home.join("auth.json")).unwrap());
        let sessions = home.join("sessions");
        assert!(sessions.join("2026").join("a.jsonl").is_file(), "bridged");
        assert_eq!(snapshot(&real), before, "real home untouched");
    }

    #[test]
    fn prepare_again_keeps_project_trust_and_the_link() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        let real = real_home(tmp.path());
        let home = prepare_codex_home(&data, None, &real, &xdev(tmp.path()), NEW).unwrap();
        // Codex trusts a folder in the private copy.
        let mut text = fs::read_to_string(home.join("config.toml")).unwrap();
        text.push_str("\n[projects.'/work/app']\ntrust_level = \"trusted\"\n");
        fs::write(home.join("config.toml"), text).unwrap();

        let again = prepare_codex_home(&data, None, &real, &xdev(tmp.path()), NEW).unwrap();
        assert_eq!(again, home);
        let config: toml::Table =
            toml::from_str(&fs::read_to_string(home.join("config.toml")).unwrap()).unwrap();
        assert_eq!(
            config["projects"]["/work/app"]["trust_level"].as_str(),
            Some("trusted")
        );
        assert!(is_linked(&real.join("auth.json"), &home.join("auth.json")).unwrap());
        let names: Vec<String> = fs::read_dir(&home)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(!names.iter().any(|n| n.ends_with(".tmp")), "{names:?}");
        assert!(
            !names.iter().any(|n| n.starts_with("auth.json.")),
            "{names:?}"
        );
    }

    #[test]
    fn a_broken_auth_link_is_kept_aside_and_linked_again() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        let real = real_home(tmp.path());
        let home = prepare_codex_home(&data, None, &real, &xdev(tmp.path()), NEW).unwrap();
        // As if codex replaced the file by a rename.
        let link = home.join("auth.json");
        fs::rename(&link, home.join("moved")).unwrap();
        fs::write(&link, "{\"fresh\":true}").unwrap();
        assert!(!is_linked(&real.join("auth.json"), &link).unwrap());

        prepare_codex_home(&data, None, &real, &xdev(tmp.path()), NEW).unwrap();
        assert!(is_linked(&real.join("auth.json"), &link).unwrap());
        let kept: Vec<PathBuf> = fs::read_dir(&home)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| {
                p.file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with("auth.json.unlinked-"))
            })
            .collect();
        assert_eq!(kept.len(), 1);
        assert_eq!(fs::read(&kept[0]).unwrap(), b"{\"fresh\":true}");
        assert_eq!(
            fs::read(real.join("auth.json")).unwrap(),
            b"{\"fake\":true}"
        );
    }

    #[test]
    fn prepare_refuses_what_it_cannot_do_safely() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        let x = xdev(tmp.path());
        let real = real_home(tmp.path());
        let old = CliVersion(0, 135, 9);
        assert!(prepare_codex_home(&data, None, &real, &x, old).is_err());

        let no_auth = tmp.path().join("no-auth");
        fs::create_dir_all(&no_auth).unwrap();
        assert!(prepare_codex_home(&data, None, &no_auth, &x, NEW).is_err());

        let bad = tmp.path().join("bad-config");
        fs::create_dir_all(&bad).unwrap();
        fs::write(bad.join("auth.json"), "{}").unwrap();
        fs::write(bad.join("config.toml"), "not = [toml").unwrap();
        assert!(prepare_codex_home(&data, Some("bad"), &bad, &x, NEW).is_err());

        // A CODEX_HOME that is already a private home.
        let private = prepare_codex_home(&data, None, &real, &x, NEW).unwrap();
        assert!(prepare_codex_home(&data, Some("again"), &private, &x, NEW).is_err());
        assert!(!data.join(CODEX_HOME_DIR).join("again").exists());
    }

    #[test]
    fn a_home_without_config_or_sessions_still_works() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        let real = tmp.path().join("bare");
        fs::create_dir_all(&real).unwrap();
        fs::write(real.join("auth.json"), "{}").unwrap();
        let home = prepare_codex_home(&data, None, &real, &xdev(tmp.path()), NEW).unwrap();
        let config: toml::Table =
            toml::from_str(&fs::read_to_string(home.join("config.toml")).unwrap()).unwrap();
        assert_eq!(config["features"]["hooks"].as_bool(), Some(true));
        assert!(!home.join("sessions").exists());
        assert!(
            !real.join("sessions").exists(),
            "nothing made in the real home"
        );
        assert_eq!(snapshot(&real).len(), 1);
    }
}
