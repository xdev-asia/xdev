use std::fs;

use std::path::{Path, PathBuf};
use tempfile::TempDir;

use xdev_ai::{AccountEntry, AiError, Provider, Registry, account_dir, carry_session};

#[test]
fn missing_file_is_empty_registry() {
    let data = TempDir::new().unwrap();
    let reg = Registry::load(data.path()).unwrap();
    assert_eq!(reg.reserve_percent, 30);
    assert!(reg.accounts.is_empty());
}

#[test]
fn round_trip() {
    let data = TempDir::new().unwrap();
    let mut reg = Registry::load(data.path()).unwrap();
    let dir = account_dir(data.path(), "claude-3");
    assert_eq!(dir, data.path().join("accounts").join("claude-3"));
    reg.add("claude-3", Provider::Claude, dir.clone()).unwrap();
    reg.add("b", Provider::Codex, data.path().join("other dir"))
        .unwrap();
    reg.set_reserve(20).unwrap();
    reg.save(data.path()).unwrap();

    let file = fs::read_to_string(data.path().join("accounts.json")).unwrap();
    let json: serde_json::Value = serde_json::from_str(&file).unwrap();
    assert_eq!(json["version"], 1);
    assert_eq!(json["reserve_percent"], 20);
    assert_eq!(json["accounts"][0]["provider"], "claude");
    assert_eq!(json["accounts"][1]["provider"], "codex");

    let back = Registry::load(data.path()).unwrap();
    assert_eq!(back.reserve_percent, 20);
    assert_eq!(back.accounts.len(), 2);
    assert_eq!(back.accounts[0].name, "claude-3");
    assert_eq!(back.accounts[0].provider, Provider::Claude);
    assert_eq!(back.accounts[0].dir, dir);
    assert_eq!(back.accounts[1].provider, Provider::Codex);
    // No temp file is left next to the registry.
    let names: Vec<_> = fs::read_dir(data.path())
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(names, vec!["accounts.json"]);
}

#[test]
fn newer_version_is_bad_and_kept() {
    let data = TempDir::new().unwrap();
    let path = data.path().join("accounts.json");
    let text = r#"{"version":2,"reserve_percent":30,"accounts":[]}"#;
    fs::write(&path, text).unwrap();
    let err = Registry::load(data.path()).unwrap_err();
    assert!(matches!(err, AiError::BadRegistry), "{err:?}");
    assert_eq!(err.code(), "bad_registry");
    assert_eq!(fs::read_to_string(&path).unwrap(), text);
}

#[test]
fn invalid_json_is_bad() {
    let data = TempDir::new().unwrap();
    fs::write(data.path().join("accounts.json"), "{nope").unwrap();
    let err = Registry::load(data.path()).unwrap_err();
    assert!(matches!(err, AiError::BadRegistry), "{err:?}");
}

#[test]
fn bad_names() {
    let data = TempDir::new().unwrap();
    let mut reg = Registry::load(data.path()).unwrap();
    let long = "a".repeat(33);
    for name in ["", "A", "-a", "a b", "a_b", "../x", long.as_str()] {
        let err = reg
            .add(name, Provider::Claude, data.path().join("x"))
            .unwrap_err();
        assert!(matches!(err, AiError::BadName), "{name:?}: {err:?}");
        assert_eq!(err.code(), "bad_name");
    }
    reg.add(&"a".repeat(32), Provider::Claude, data.path().join("x"))
        .unwrap();
    reg.add("0-a-", Provider::Claude, data.path().join("y"))
        .unwrap();
}

#[test]
fn duplicate_is_exists() {
    let data = TempDir::new().unwrap();
    let mut reg = Registry::load(data.path()).unwrap();
    reg.add("a", Provider::Claude, data.path().join("x"))
        .unwrap();
    let err = reg
        .add("a", Provider::Claude, data.path().join("y"))
        .unwrap_err();
    assert!(matches!(err, AiError::Exists));
    assert_eq!(err.code(), "exists");
}

#[test]
fn reserve_range() {
    let data = TempDir::new().unwrap();
    let mut reg = Registry::load(data.path()).unwrap();
    reg.set_reserve(0).unwrap();
    reg.set_reserve(90).unwrap();
    let err = reg.set_reserve(91).unwrap_err();
    assert!(matches!(err, AiError::BadReserve));
    assert_eq!(err.code(), "bad_reserve");
    assert_eq!(reg.reserve_percent, 90);
}

#[test]
fn hand_edited_file_breaking_the_rules_is_bad() {
    let data = TempDir::new().unwrap();
    let path = data.path().join("accounts.json");
    for text in [
        r#"{"version":1,"reserve_percent":95,"accounts":[]}"#,
        r#"{"version":1,"reserve_percent":30,"accounts":[{"name":"../x","provider":"claude","dir":"d"}]}"#,
        r#"{"version":1,"reserve_percent":30,"accounts":[{"name":"a","provider":"nope","dir":"d"}]}"#,
        r#"{"version":1,"reserve_percent":30,"accounts":[{"name":"a","provider":"claude","dir":"d"},{"name":"a","provider":"claude","dir":"e"}]}"#,
    ] {
        fs::write(&path, text).unwrap();
        let err = Registry::load(data.path()).unwrap_err();
        assert!(matches!(err, AiError::BadRegistry), "{text}: {err:?}");
    }
}

#[test]
fn remove() {
    let data = TempDir::new().unwrap();
    let mut reg = Registry::load(data.path()).unwrap();
    let err = reg.remove("nope").unwrap_err();
    assert!(matches!(err, AiError::NotFound));
    assert_eq!(err.code(), "not_found");

    reg.add("a", Provider::Claude, data.path().join("x"))
        .unwrap();
    let gone = reg.remove("a").unwrap();
    assert_eq!(gone.name, "a");
    assert!(reg.accounts.is_empty());
}

#[test]
fn error_codes() {
    assert_eq!(AiError::NoClaude.code(), "no_claude");
    assert_eq!(AiError::NoCodex.code(), "no_codex");
    assert_eq!(AiError::UnknownProvider.code(), "unknown_provider");
    assert_eq!(AiError::SessionMissing.code(), "session_missing");
    assert_eq!(AiError::Io(std::io::Error::other("x")).code(), "io");
}

#[test]
fn provider_names() {
    for p in Provider::ALL {
        assert_eq!(Provider::parse(p.as_str()).unwrap(), p);
        assert_eq!(serde_json::to_value(p).unwrap(), p.as_str());
        assert_eq!(
            serde_json::from_value::<Provider>(p.as_str().into()).unwrap(),
            p
        );
    }
    let ids: Vec<&str> = Provider::ALL.iter().map(|p| p.as_str()).collect();
    assert_eq!(
        ids,
        [
            "claude",
            "codex",
            "gemini",
            "qwen-code",
            "opencode",
            "amp",
            "cursor"
        ]
    );
    assert!(matches!(
        Provider::parse("Codex"),
        Err(AiError::UnknownProvider)
    ));
}

// --- active account ---

fn two_providers(data: &TempDir) -> Registry {
    let mut reg = Registry::load(data.path()).unwrap();
    reg.add("work", Provider::Claude, data.path().join("w"))
        .unwrap();
    reg.add("home", Provider::Claude, data.path().join("h"))
        .unwrap();
    reg.add("gpt", Provider::Codex, data.path().join("g"))
        .unwrap();
    reg
}

#[test]
fn activate_sets_one_per_provider() {
    let data = TempDir::new().unwrap();
    let mut reg = two_providers(&data);
    assert!(reg.active(Provider::Claude).is_none());
    reg.activate(Provider::Claude, Some("work")).unwrap();
    reg.activate(Provider::Codex, Some("gpt")).unwrap();
    reg.activate(Provider::Claude, Some("home")).unwrap();
    assert_eq!(reg.active(Provider::Claude).unwrap().name, "home");
    assert_eq!(reg.active(Provider::Codex).unwrap().name, "gpt");
    assert_eq!(reg.active.len(), 2);
    // None goes back to the CLI's own home for that provider only.
    reg.activate(Provider::Claude, None).unwrap();
    assert!(reg.active(Provider::Claude).is_none());
    assert_eq!(reg.active(Provider::Codex).unwrap().name, "gpt");
}

#[test]
fn activate_unknown_or_other_provider_is_not_found() {
    let data = TempDir::new().unwrap();
    let mut reg = two_providers(&data);
    reg.activate(Provider::Claude, Some("work")).unwrap();
    for (provider, name) in [
        (Provider::Claude, "nobody"),
        (Provider::Claude, "gpt"),
        (Provider::Codex, "work"),
    ] {
        let err = reg.activate(provider, Some(name)).unwrap_err();
        assert!(matches!(err, AiError::NotFound), "{name}: {err:?}");
        assert_eq!(err.code(), "not_found");
    }
    // A refused activation leaves the active account as it was.
    assert_eq!(reg.active(Provider::Claude).unwrap().name, "work");
    assert!(reg.active(Provider::Codex).is_none());
}

#[test]
fn remove_of_the_active_account_clears_it() {
    let data = TempDir::new().unwrap();
    let mut reg = two_providers(&data);
    reg.activate(Provider::Claude, Some("work")).unwrap();
    reg.activate(Provider::Codex, Some("gpt")).unwrap();
    reg.remove("home").unwrap();
    assert_eq!(reg.active(Provider::Claude).unwrap().name, "work");
    reg.remove("work").unwrap();
    assert!(reg.active(Provider::Claude).is_none());
    assert_eq!(reg.active.len(), 1);
    assert_eq!(reg.active(Provider::Codex).unwrap().name, "gpt");
}

#[test]
fn save_keeps_the_active_accounts() {
    let data = TempDir::new().unwrap();
    let mut reg = two_providers(&data);
    reg.activate(Provider::Claude, Some("home")).unwrap();
    reg.save(data.path()).unwrap();

    let file = fs::read_to_string(data.path().join("accounts.json")).unwrap();
    let json: serde_json::Value = serde_json::from_str(&file).unwrap();
    assert_eq!(json["version"], 1);
    assert_eq!(
        json["active"],
        serde_json::json!([{ "provider": "claude", "name": "home" }])
    );
    let back = Registry::load(data.path()).unwrap();
    assert_eq!(back, reg);
    assert_eq!(back.active(Provider::Claude).unwrap().name, "home");
}

#[test]
fn a_file_without_active_loads_with_none() {
    let data = TempDir::new().unwrap();
    let text = r#"{"version":1,"reserve_percent":30,"accounts":[
        {"name":"work","provider":"claude","dir":"w"}]}"#;
    fs::write(data.path().join("accounts.json"), text).unwrap();
    let reg = Registry::load(data.path()).unwrap();
    assert_eq!(reg.accounts.len(), 1);
    assert!(reg.active.is_empty());
    assert!(reg.active(Provider::Claude).is_none());
}

#[test]
fn an_active_entry_that_names_no_account_is_dropped_on_load() {
    let data = TempDir::new().unwrap();
    // Hand edits: a gone account, another provider's, and a second entry
    // for one provider. Each is left out rather than refusing the file.
    let text = r#"{"version":1,"reserve_percent":30,"accounts":[
        {"name":"work","provider":"claude","dir":"w"},
        {"name":"gpt","provider":"codex","dir":"g"}],
        "active":[
        {"provider":"claude","name":"gone"},
        {"provider":"codex","name":"work"},
        {"provider":"claude","name":"work"},
        {"provider":"claude","name":"work"}]}"#;
    fs::write(data.path().join("accounts.json"), text).unwrap();
    let reg = Registry::load(data.path()).unwrap();
    assert_eq!(
        reg.active,
        vec![xdev_ai::ActiveAccount {
            provider: Provider::Claude,
            name: "work".into()
        }]
    );
}

// --- carry a session ---

const ID: &str = "0b9e8c1e-4f6a-4c2b-9a51-1f2e3d4c5b6a";

fn entry(provider: Provider, dir: &Path) -> AccountEntry {
    AccountEntry {
        name: "x".into(),
        provider,
        dir: dir.to_path_buf(),
    }
}

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

/// Two Claude homes under a temp dir; the session ran in `<tmp>/repo`.
fn claude_homes(tmp: &TempDir) -> (AccountEntry, AccountEntry, PathBuf) {
    let from = entry(Provider::Claude, &tmp.path().join("from"));
    let to = entry(Provider::Claude, &tmp.path().join("to"));
    (from, to, tmp.path().join("repo"))
}

fn claude_key(cwd: &Path) -> String {
    cwd.to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

#[test]
fn carry_claude_copies_the_log_to_the_same_path() {
    let tmp = TempDir::new().unwrap();
    let (from, to, cwd) = claude_homes(&tmp);
    let rel = Path::new("projects")
        .join(claude_key(&cwd))
        .join(format!("{ID}.jsonl"));
    write(
        &from.dir.join(&rel),
        "{\"a\":1}
",
    );
    assert!(carry_session(&from, &to, ID, &cwd).unwrap());
    assert_eq!(
        fs::read_to_string(to.dir.join(&rel)).unwrap(),
        "{\"a\":1}
"
    );
    // The source stays.
    assert!(from.dir.join(&rel).is_file());
    // A second carry finds it there.
    assert!(!carry_session(&from, &to, ID, &cwd).unwrap());
}

#[test]
fn carry_claude_finds_a_log_under_another_project_folder() {
    let tmp = TempDir::new().unwrap();
    let (from, to, cwd) = claude_homes(&tmp);
    let rel = Path::new("projects")
        .join("-elsewhere")
        .join(format!("{ID}.jsonl"));
    write(&from.dir.join(&rel), "x");
    assert!(carry_session(&from, &to, ID, &cwd).unwrap());
    assert!(to.dir.join(&rel).is_file());
}

#[test]
fn carry_never_overwrites_what_the_target_has() {
    let tmp = TempDir::new().unwrap();
    let (from, to, cwd) = claude_homes(&tmp);
    let rel = Path::new("projects")
        .join(claude_key(&cwd))
        .join(format!("{ID}.jsonl"));
    write(&from.dir.join(&rel), "new");
    // Under another project folder in the target still counts as there.
    let theirs = to
        .dir
        .join("projects")
        .join("-other")
        .join(format!("{ID}.jsonl"));
    write(&theirs, "old");
    assert!(!carry_session(&from, &to, ID, &cwd).unwrap());
    assert_eq!(fs::read_to_string(&theirs).unwrap(), "old");
    assert!(!to.dir.join(&rel).exists());
}

#[test]
fn carry_codex_copies_the_rollout_by_its_id() {
    let tmp = TempDir::new().unwrap();
    let from = entry(Provider::Codex, &tmp.path().join("from"));
    let to = entry(Provider::Codex, &tmp.path().join("to"));
    let rel =
        Path::new("sessions/2026/11/04").join(format!("rollout-2026-11-04T10-00-00-{ID}.jsonl"));
    write(&from.dir.join(&rel), "codex");
    // Another session's log is left alone.
    write(
        &from
            .dir
            .join("sessions/2026/11/04/rollout-2026-11-04T09-00-00-other.jsonl"),
        "o",
    );
    let cwd = tmp.path().join("repo");
    assert!(carry_session(&from, &to, ID, &cwd).unwrap());
    assert_eq!(fs::read_to_string(to.dir.join(&rel)).unwrap(), "codex");
    assert_eq!(
        fs::read_dir(to.dir.join("sessions/2026/11/04"))
            .unwrap()
            .count(),
        1
    );
    assert!(!carry_session(&from, &to, ID, &cwd).unwrap());
}

#[test]
fn carry_of_a_missing_or_bad_session_is_session_missing() {
    let tmp = TempDir::new().unwrap();
    let (from, to, cwd) = claude_homes(&tmp);
    write(&from.dir.join("projects/-x/other.jsonl"), "x");
    for id in [ID, "", "../other", "a/b", &"a".repeat(129)] {
        let err = carry_session(&from, &to, id, &cwd).unwrap_err();
        assert_eq!(err.code(), "session_missing", "{id}");
    }
    let from = entry(Provider::Codex, &tmp.path().join("cfrom"));
    let to = entry(Provider::Codex, &tmp.path().join("cto"));
    let err = carry_session(&from, &to, ID, &cwd).unwrap_err();
    assert_eq!(err.code(), "session_missing");
    assert!(!to.dir.exists());
}

// --- single-account providers ---

#[test]
fn only_providers_with_a_home_variable_are_isolated() {
    let isolated: Vec<Provider> = Provider::ALL.into_iter().filter(|p| p.isolated()).collect();
    assert_eq!(
        isolated,
        [Provider::Claude, Provider::Codex, Provider::Gemini]
    );
    assert_eq!(Provider::Gemini.home_var(), Some("GEMINI_CLI_HOME"));
    assert_eq!(Provider::Amp.home_var(), None);
}

#[test]
fn a_single_account_provider_refuses_a_second_account() {
    let data = TempDir::new().unwrap();
    let mut reg = Registry::default();
    reg.add("amp", Provider::Amp, data.path().join("amp"))
        .unwrap();
    let err = reg
        .add("amp-2", Provider::Amp, data.path().join("amp-2"))
        .unwrap_err();
    assert!(matches!(err, AiError::SingleAccount));
    assert_eq!(err.code(), "single_account");
    // Refused before the CLI is looked for or a folder is made.
    let err = reg.create(data.path(), "amp-3", Provider::Amp).unwrap_err();
    assert!(matches!(err, AiError::SingleAccount));
    assert_eq!(reg.accounts.len(), 1);
    // Nothing to switch to.
    assert!(matches!(
        reg.activate(Provider::Amp, Some("amp")),
        Err(AiError::SingleAccount)
    ));
    reg.activate(Provider::Amp, None).unwrap();
    // An isolated provider keeps as many as it likes.
    for name in ["g1", "g2"] {
        reg.add(name, Provider::Gemini, account_dir(data.path(), name))
            .unwrap();
    }
    reg.activate(Provider::Gemini, Some("g2")).unwrap();
}

#[test]
fn a_file_with_two_single_accounts_is_bad() {
    let data = TempDir::new().unwrap();
    write(
        &data.path().join("accounts.json"),
        r#"{"version":1,"reserve_percent":30,"accounts":[
            {"name":"a","provider":"cursor","dir":"x"},
            {"name":"b","provider":"cursor","dir":"y"}]}"#,
    );
    assert!(matches!(
        Registry::load(data.path()),
        Err(AiError::BadRegistry)
    ));
}
