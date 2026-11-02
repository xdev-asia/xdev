use std::fs;

use tempfile::TempDir;
use xdev_ai::{AiError, Provider, Registry, account_dir};

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
        r#"{"version":1,"reserve_percent":30,"accounts":[{"name":"a","provider":"gemini","dir":"d"}]}"#,
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
    assert_eq!(AiError::Io(std::io::Error::other("x")).code(), "io");
}

#[test]
fn provider_names() {
    for p in [Provider::Claude, Provider::Codex] {
        assert_eq!(Provider::parse(p.as_str()).unwrap(), p);
        assert_eq!(serde_json::to_value(p).unwrap(), p.as_str());
    }
    assert!(matches!(
        Provider::parse("Codex"),
        Err(AiError::UnknownProvider)
    ));
}
