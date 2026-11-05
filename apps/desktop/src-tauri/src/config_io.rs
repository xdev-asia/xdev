//! Settings → Advanced → Export and import settings. A file is
//! `{ "xdev": 1, "exported": <iso>, "sections": { <name>: <section> } }`.
//! Secrets never go in or out: `strip_secrets` is the deny list, applied on
//! export and again on import, so a hand-made file cannot plant one. Planning
//! and merging are pure; only the commands touch a dialog, a file or the
//! settings store.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::commands::CmdError;
use crate::settings::{Settings, SettingsSection};

/// The file format version this build writes and reads.
pub const FORMAT: u64 = 1;
/// The biggest file an import reads.
const MAX_FILE: u64 = 1024 * 1024;
/// A shown value is cut to this many characters.
const SHOWN_MAX: usize = 80;

/// The settings sections a file may carry, as their keys in `settings.json`.
/// Not listed on purpose: `version`, `lastVault` and `vaultPrompted` (this
/// machine), `quickCommandsRecent` (history) and `xdevId` (the account's
/// server and sign-in).
pub const SECTIONS: &[&str] = &[
    "git",
    "status",
    "terminal",
    "keys",
    "ui",
    "quickCommands",
    "openIn",
    "editor",
    "sidebar",
    "navigation",
    "diff",
    "agents",
    "usage",
    "orchestration",
    "shell",
    "automations",
    "network",
];

/// The change event's name for a section key.
fn event_section(key: &str) -> Option<SettingsSection> {
    Some(match key {
        "git" => SettingsSection::Git,
        "status" => SettingsSection::Status,
        "terminal" => SettingsSection::Terminal,
        "keys" => SettingsSection::Keys,
        "ui" => SettingsSection::Ui,
        "quickCommands" => SettingsSection::QuickCommands,
        "openIn" => SettingsSection::OpenIn,
        "editor" => SettingsSection::Editor,
        "sidebar" => SettingsSection::Sidebar,
        "navigation" => SettingsSection::Navigation,
        "diff" => SettingsSection::Diff,
        "agents" => SettingsSection::Agents,
        "usage" => SettingsSection::Usage,
        "orchestration" => SettingsSection::Orchestration,
        "shell" => SettingsSection::Shell,
        "automations" => SettingsSection::Automations,
        "network" => SettingsSection::Network,
        _ => return None,
    })
}

/// Names whose value is a secret, compared with case and `_`/`-` ignored: the
/// whole name or its ending. `author` is not `auth`: only the whole word counts
/// for that one.
const SECRET_ENDINGS: &[&str] = &[
    "token",
    "secret",
    "password",
    "passwd",
    "passphrase",
    "credential",
    "credentials",
    "apikey",
    "authorization",
    "cookie",
    "privatekey",
    "accesskey",
    "sessionkey",
];
const SECRET_WHOLE: &[&str] = &["auth"];

/// Whether a field called `name` holds a secret.
pub fn is_secret_name(name: &str) -> bool {
    let n: String = name
        .chars()
        .filter(|c| !matches!(c, '_' | '-'))
        .flat_map(char::to_lowercase)
        .collect();
    SECRET_WHOLE.contains(&n.as_str()) || SECRET_ENDINGS.iter().any(|e| n.ends_with(e))
}

/// `value` without anything secret, and how many fields were taken out. An
/// object field named like a secret goes, and so does a row of an env list
/// (`{ "key", "value", "secret": true }`) that is marked secret.
pub fn strip_secrets(value: &Value) -> (Value, usize) {
    match value {
        Value::Object(map) => {
            if map.get("secret") == Some(&Value::Bool(true)) {
                return (Value::Null, 1);
            }
            let mut out = Map::new();
            let mut n = 0;
            for (k, v) in map {
                // The `secret` flag of an env row is a marker, not a value.
                if is_secret_name(k) && !(k == "secret" && v.is_boolean()) {
                    n += 1;
                    continue;
                }
                let (clean, removed) = strip_secrets(v);
                n += removed;
                out.insert(k.clone(), clean);
            }
            (Value::Object(out), n)
        }
        Value::Array(items) => {
            let mut out = Vec::new();
            let mut n = 0;
            for item in items {
                let (clean, removed) = strip_secrets(item);
                n += removed;
                // A secret row is dropped whole, not left as a null.
                let gone = item
                    .as_object()
                    .is_some_and(|m| m.get("secret") == Some(&Value::Bool(true)));
                if !gone {
                    out.push(clean);
                }
            }
            (Value::Array(out), n)
        }
        other => (other.clone(), 0),
    }
}

/// Why an export or an import was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigError {
    /// Not JSON, or not the file's shape.
    Shape,
    /// `xdev` is missing or is a version this build does not read.
    Version(Option<u64>),
    /// Nothing was chosen, or none of it can be exported.
    NoSections,
    TooLarge,
}

impl ConfigError {
    pub fn code(&self) -> &'static str {
        match self {
            ConfigError::Shape => "config_shape",
            ConfigError::Version(_) => "config_version",
            ConfigError::NoSections => "config_sections",
            ConfigError::TooLarge => "config_too_large",
        }
    }
}

impl From<ConfigError> for CmdError {
    fn from(e: ConfigError) -> CmdError {
        CmdError {
            code: e.code(),
            detail: match &e {
                ConfigError::Version(Some(v)) => Some(v.to_string()),
                _ => None,
            },
        }
    }
}

/// The export document for the chosen `sections` of `settings` (a serialized
/// `Settings`), with `exported` as its timestamp. A key that is not in
/// `SECTIONS` is skipped; none left is `NoSections`.
pub fn build_export(
    settings: &Value,
    sections: &[String],
    exported: &str,
) -> Result<Value, ConfigError> {
    let mut out = Map::new();
    for key in SECTIONS {
        if !sections.iter().any(|s| s == key) {
            continue;
        }
        if let Some(v) = settings.get(*key) {
            out.insert((*key).to_owned(), strip_secrets(v).0);
        }
    }
    if out.is_empty() {
        return Err(ConfigError::NoSections);
    }
    Ok(serde_json::json!({ "xdev": FORMAT, "exported": exported, "sections": out }))
}

/// One changed value, shown as short text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConfigChange {
    /// Dotted, from the section: `terminal.fontSize`.
    pub path: String,
    pub from: String,
    pub to: String,
}

/// What importing one section would do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SectionPreview {
    pub section: String,
    pub changes: Vec<ConfigChange>,
    /// Keys this build has no field for; they are left out.
    pub unknown: Vec<String>,
    /// Secret fields the file had; they are left out.
    pub secrets_removed: u32,
    /// The section's value does not fit this build's shape (or a check such
    /// as the proxy's); it cannot be applied.
    pub invalid: bool,
}

/// The whole preview of a file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub exported: String,
    pub sections: Vec<SectionPreview>,
    /// Section names in the file this build does not know.
    pub unknown_sections: Vec<String>,
}

/// What an import did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ImportApplied {
    pub applied: Vec<String>,
}

/// What an export did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConfigExported {
    pub path: String,
    pub sections: Vec<String>,
}

/// Checks the frame of a file: an object with `xdev` equal to `FORMAT`, an
/// `exported` text (may be empty) and an object `sections`.
pub fn parse_file(file: &Value) -> Result<(&str, &Map<String, Value>), ConfigError> {
    let obj = file.as_object().ok_or(ConfigError::Shape)?;
    match obj.get("xdev") {
        None => return Err(ConfigError::Version(None)),
        Some(v) if v.as_u64() == Some(FORMAT) => {}
        Some(v) => return Err(ConfigError::Version(v.as_u64())),
    }
    let sections = obj
        .get("sections")
        .and_then(Value::as_object)
        .ok_or(ConfigError::Shape)?;
    let exported = match obj.get("exported") {
        None => "",
        Some(Value::String(s)) => s.as_str(),
        Some(_) => return Err(ConfigError::Shape),
    };
    Ok((exported, sections))
}

fn shown(v: &Value) -> String {
    let text = match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    if text.chars().count() > SHOWN_MAX {
        let cut: String = text.chars().take(SHOWN_MAX).collect();
        format!("{cut}…")
    } else {
        text
    }
}

/// Takes the fields of `incoming` that `current` has, recursively; objects
/// merge, anything else is replaced whole. A key `current` lacks is added to
/// `unknown`. Returns the merged value and fills `changes`.
fn merge_into(
    path: &str,
    current: &Value,
    incoming: &Value,
    changes: &mut Vec<ConfigChange>,
    unknown: &mut Vec<String>,
) -> Value {
    match (current, incoming) {
        (Value::Object(cur), Value::Object(inc)) => {
            let mut out = cur.clone();
            for (k, v) in inc {
                let here = if path.is_empty() {
                    k.clone()
                } else {
                    format!("{path}.{k}")
                };
                match cur.get(k) {
                    Some(c) => {
                        out.insert(k.clone(), merge_into(&here, c, v, changes, unknown));
                    }
                    None => unknown.push(here),
                }
            }
            Value::Object(out)
        }
        (c, i) => {
            if c != i {
                changes.push(ConfigChange {
                    path: path.to_owned(),
                    from: shown(c),
                    to: shown(i),
                });
            }
            i.clone()
        }
    }
}

/// `section` of `current` with the known, non-secret fields of `incoming`
/// laid over it; the changes, the unknown keys and the number of secrets left
/// out. `invalid` when the result does not survive being read back as this
/// build's settings (a wrong type, say) or fails the section's own check.
pub fn merge_section(
    section: &str,
    current: &Settings,
    incoming: &Value,
) -> (Value, SectionPreview) {
    let cur = serde_json::to_value(current).unwrap_or(Value::Null);
    let cur_section = cur.get(section).cloned().unwrap_or(Value::Null);
    let (clean, removed) = strip_secrets(incoming);
    let mut changes = Vec::new();
    let mut unknown = Vec::new();
    let merged = merge_into(section, &cur_section, &clean, &mut changes, &mut unknown);
    // The paths start with the section name; show them from inside it.
    let prefix = format!("{section}.");
    for c in &mut changes {
        if let Some(rest) = c.path.strip_prefix(&prefix) {
            c.path = rest.to_owned();
        } else if c.path == section {
            c.path = String::new();
        }
    }
    for u in &mut unknown {
        if let Some(rest) = u.strip_prefix(&prefix) {
            *u = rest.to_owned();
        }
    }
    let invalid = !fits(section, &cur, &merged);
    let preview = SectionPreview {
        section: section.to_owned(),
        changes,
        unknown,
        secrets_removed: removed as u32,
        invalid,
    };
    (merged, preview)
}

/// Reading `merged` back through `Settings` gives `merged` again, and the
/// section passes the check its own page applies on save.
fn fits(section: &str, current: &Value, merged: &Value) -> bool {
    let mut doc = current.clone();
    let Some(map) = doc.as_object_mut() else {
        return false;
    };
    map.insert(section.to_owned(), merged.clone());
    let Ok(parsed) = serde_json::from_value::<Settings>(doc) else {
        return false;
    };
    let back = serde_json::to_value(&parsed).unwrap_or(Value::Null);
    if back.get(section) != Some(merged) {
        return false;
    }
    section != "network" || crate::network::invalid_field(&parsed.network).is_none()
}

/// The preview of `file` against `current`, one entry per known section in
/// file order. Secrets in the file are counted, never carried.
pub fn plan_import(file: &Value, current: &Settings) -> Result<ImportPreview, ConfigError> {
    let (exported, sections) = parse_file(file)?;
    let mut out = Vec::new();
    let mut unknown_sections = Vec::new();
    for (name, value) in sections {
        if !SECTIONS.contains(&name.as_str()) {
            unknown_sections.push(name.clone());
            continue;
        }
        out.push(merge_section(name, current, value).1);
    }
    Ok(ImportPreview {
        exported: exported.to_owned(),
        sections: out,
        unknown_sections,
    })
}

/// `current` with the chosen sections of `file` merged in. Returns the names
/// that were applied; a section that is unknown, not chosen or `invalid` is
/// left alone.
pub fn apply_import(
    file: &Value,
    chosen: &[String],
    current: &mut Settings,
) -> Result<Vec<String>, ConfigError> {
    let (_, sections) = parse_file(file)?;
    let mut applied = Vec::new();
    let mut doc = serde_json::to_value(&*current).map_err(|_| ConfigError::Shape)?;
    for (name, value) in sections {
        if !SECTIONS.contains(&name.as_str()) || !chosen.contains(name) {
            continue;
        }
        let (merged, preview) = merge_section(name, current, value);
        if preview.invalid {
            continue;
        }
        if let Some(map) = doc.as_object_mut() {
            map.insert(name.clone(), merged);
        }
        applied.push(name.clone());
    }
    if let Ok(next) = serde_json::from_value::<Settings>(doc) {
        *current = next;
    }
    Ok(applied)
}

fn err(code: &'static str, e: impl std::fmt::Display) -> CmdError {
    CmdError {
        code,
        detail: Some(e.to_string()),
    }
}

fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

fn read_file(path: &Path) -> Result<Value, CmdError> {
    let meta = std::fs::metadata(path).map_err(|e| err("io", e))?;
    if meta.len() > MAX_FILE {
        return Err(ConfigError::TooLarge.into());
    }
    let bytes = std::fs::read(path).map_err(|e| err("io", e))?;
    serde_json::from_slice(&bytes).map_err(|_| ConfigError::Shape.into())
}

fn is_json(path: &Path) -> bool {
    path.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("json"))
}

/// Asks where to save in a native dialog opened here, then writes the chosen
/// sections without secrets. `None` means the person cancelled.
#[tauri::command(async)]
pub fn config_export(
    app: tauri::AppHandle,
    sections: Vec<String>,
) -> Result<Option<ConfigExported>, CmdError> {
    use tauri_plugin_dialog::DialogExt;
    let settings =
        serde_json::to_value(crate::settings_store::read(&app)).map_err(|e| err("io", e))?;
    // Built before the dialog, so a bad choice is refused without asking.
    let doc = build_export(&settings, &sections, &now_iso())?;
    let Some(picked) = app
        .dialog()
        .file()
        .set_file_name("xdev-settings.json")
        .add_filter("JSON", &["json"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let mut path: PathBuf = picked.into_path().map_err(|e| err("io", e))?;
    if !is_json(&path) {
        path.set_extension("json");
    }
    let text = serde_json::to_string_pretty(&doc).map_err(|e| err("io", e))?;
    crate::atomic::write_atomic(&path, text.as_bytes()).map_err(|e| err("io", e))?;
    let names = doc["sections"]
        .as_object()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    Ok(Some(ConfigExported {
        path: path.to_string_lossy().into_owned(),
        sections: names,
    }))
}

/// Reads the file at `path` and says what importing it would change. Changes
/// nothing.
#[tauri::command(async)]
pub fn config_import_preview(
    app: tauri::AppHandle,
    path: String,
) -> Result<ImportPreview, CmdError> {
    let file = read_file(Path::new(&path))?;
    Ok(plan_import(&file, &crate::settings_store::read(&app))?)
}

/// Applies the chosen sections of the file at `path` through the settings
/// store; the file is read and checked again here.
#[tauri::command(async)]
pub fn config_import_apply(
    app: tauri::AppHandle,
    path: String,
    sections: Vec<String>,
) -> Result<ImportApplied, CmdError> {
    let file = read_file(Path::new(&path))?;
    let events: Vec<SettingsSection> = sections.iter().filter_map(|s| event_section(s)).collect();
    let mut applied = Vec::new();
    crate::settings_store::write(&app, &events, |s| {
        applied = apply_import(&file, &sections, s).unwrap_or_default();
    })?;
    Ok(ImportApplied { applied })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn current() -> Settings {
        Settings::default()
    }

    #[test]
    fn secret_names_are_matched_by_ending_and_whole_word() {
        for name in [
            "token",
            "accessToken",
            "api_key",
            "apiKey",
            "clientSecret",
            "password",
            "Authorization",
            "auth",
            "cookie",
            "private-key",
            "sessionKey",
            "credentials",
        ] {
            assert!(is_secret_name(name), "{name}");
        }
        for name in [
            "tokenUsage",
            "prBotAuthorOverrides",
            "author",
            "fontSize",
            "keys",
            "keyboard",
            "proxyUrl",
        ] {
            assert!(!is_secret_name(name), "{name}");
        }
    }

    #[test]
    fn strip_removes_each_secret_field_at_any_depth() {
        let input = json!({
            "token": "t",
            "apiKey": "k",
            "password": "p",
            "clientSecret": "s",
            "credentials": { "user": "u" },
            "nested": { "accessToken": "a", "ok": 1, "deep": [{ "cookie": "c", "name": "n" }] },
            "keep": "yes"
        });
        let (out, n) = strip_secrets(&input);
        assert_eq!(n, 7);
        assert_eq!(
            out,
            json!({ "nested": { "ok": 1, "deep": [{ "name": "n" }] }, "keep": "yes" })
        );
        assert!(!out.to_string().contains("\"t\""));
    }

    #[test]
    fn strip_drops_secret_env_rows_whole() {
        let input = json!({ "env": [
            { "key": "A", "value": "1", "secret": false },
            { "key": "B", "value": "hunter2", "secret": true }
        ]});
        let (out, n) = strip_secrets(&input);
        assert_eq!(n, 1);
        assert_eq!(
            out,
            json!({ "env": [{ "key": "A", "value": "1", "secret": false }] })
        );
        assert!(!out.to_string().contains("hunter2"));
    }

    #[test]
    fn export_has_the_frame_and_only_the_chosen_known_sections() {
        let mut settings = serde_json::to_value(current()).unwrap();
        settings["network"]["proxyToken"] = json!("leak");
        let doc = build_export(
            &settings,
            &[
                "network".into(),
                "xdevId".into(),
                "lastVault".into(),
                "git".into(),
            ],
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        assert_eq!(doc["xdev"], 1);
        assert_eq!(doc["exported"], "2026-01-01T00:00:00Z");
        let names: Vec<_> = doc["sections"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        assert_eq!(names, ["git", "network"]);
        assert!(!doc.to_string().contains("leak"));
    }

    #[test]
    fn export_of_nothing_is_refused() {
        let settings = serde_json::to_value(current()).unwrap();
        let e = build_export(&settings, &[], "x").unwrap_err();
        assert_eq!(e, ConfigError::NoSections);
        let e = build_export(&settings, &["xdevId".into()], "x").unwrap_err();
        assert_eq!(e.code(), "config_sections");
    }

    #[test]
    fn a_real_settings_export_carries_no_secret_named_field() {
        fn walk(v: &Value, bad: &mut Vec<String>) {
            match v {
                Value::Object(m) => {
                    for (k, v) in m {
                        if is_secret_name(k) {
                            bad.push(k.clone());
                        }
                        walk(v, bad);
                    }
                }
                Value::Array(a) => a.iter().for_each(|v| walk(v, bad)),
                _ => {}
            }
        }
        let settings = serde_json::to_value(current()).unwrap();
        let all: Vec<String> = SECTIONS.iter().map(|s| (*s).to_owned()).collect();
        let doc = build_export(&settings, &all, "x").unwrap();
        let mut bad = Vec::new();
        walk(&doc, &mut bad);
        assert!(bad.is_empty(), "{bad:?}");
    }

    #[test]
    fn the_frame_is_validated() {
        let ok = json!({ "xdev": 1, "exported": "t", "sections": {} });
        assert!(parse_file(&ok).is_ok());
        let code = |v: Value| parse_file(&v).unwrap_err();
        assert_eq!(code(json!([])), ConfigError::Shape);
        assert_eq!(code(json!({ "sections": {} })), ConfigError::Version(None));
        assert_eq!(
            code(json!({ "xdev": 2, "sections": {} })),
            ConfigError::Version(Some(2))
        );
        assert_eq!(
            code(json!({ "xdev": "1", "sections": {} })),
            ConfigError::Version(None)
        );
        assert_eq!(code(json!({ "xdev": 1 })), ConfigError::Shape);
        assert_eq!(
            code(json!({ "xdev": 1, "sections": [] })),
            ConfigError::Shape
        );
        assert_eq!(
            code(json!({ "xdev": 1, "exported": 5, "sections": {} })),
            ConfigError::Shape
        );
    }

    #[test]
    fn the_preview_lists_changes_unknown_keys_and_unknown_sections() {
        let file = json!({ "xdev": 1, "exported": "t", "sections": {
            "network": { "proxyUrl": "http://p:1", "futureField": 1, "token": "x" },
            "mystery": { "a": 1 }
        }});
        let p = plan_import(&file, &current()).unwrap();
        assert_eq!(p.unknown_sections, ["mystery"]);
        assert_eq!(p.sections.len(), 1);
        let s = &p.sections[0];
        assert_eq!(s.section, "network");
        assert_eq!(
            s.changes,
            [ConfigChange {
                path: "proxyUrl".into(),
                from: String::new(),
                to: "http://p:1".into()
            }]
        );
        assert_eq!(s.unknown, ["futureField"]);
        assert_eq!(s.secrets_removed, 1);
        assert!(!s.invalid);
    }

    #[test]
    fn a_value_of_the_wrong_type_makes_the_section_invalid() {
        let file = json!({ "xdev": 1, "sections": { "network": { "proxyUrl": 7 } } });
        let p = plan_import(&file, &current()).unwrap();
        assert!(p.sections[0].invalid);
        let file = json!({ "xdev": 1, "sections": { "network": { "proxyUrl": "ftp://x" } } });
        assert!(plan_import(&file, &current()).unwrap().sections[0].invalid);
    }

    #[test]
    fn apply_merges_only_chosen_valid_sections_and_ignores_the_rest() {
        let file = json!({ "xdev": 1, "sections": {
            "network": { "proxyUrl": "http://p:1", "machineName": "box", "extra": true },
            "git": { "branchPrefix": "none" },
            "mystery": { "a": 1 }
        }});
        let mut s = current();
        s.network.node_mirror = "https://keep.example".into();
        let applied = apply_import(&file, &["network".into(), "mystery".into()], &mut s).unwrap();
        assert_eq!(applied, ["network"]);
        assert_eq!(s.network.proxy_url, "http://p:1");
        assert_eq!(s.network.machine_name, "box");
        // A field the file lacks keeps its value.
        assert_eq!(s.network.node_mirror, "https://keep.example");
        // A section not chosen is untouched.
        assert_eq!(s.git, current().git);
    }

    #[test]
    fn apply_never_imports_a_secret_even_when_the_file_has_one() {
        let file = json!({ "xdev": 1, "sections": {
            "network": { "proxyUrl": "http://p:1", "token": "leak", "apiKey": "leak" }
        }});
        let mut s = current();
        apply_import(&file, &["network".into()], &mut s).unwrap();
        let text = serde_json::to_string(&s).unwrap();
        assert!(!text.contains("leak"));
        assert_eq!(s.network.proxy_url, "http://p:1");
    }

    #[test]
    fn an_invalid_section_is_skipped_by_apply() {
        let file = json!({ "xdev": 1, "sections": { "network": { "proxyUrl": "ftp://x" } } });
        let mut s = current();
        let applied = apply_import(&file, &["network".into()], &mut s).unwrap();
        assert!(applied.is_empty());
        assert_eq!(s, current());
    }

    #[test]
    fn export_then_import_round_trips() {
        let mut s = current();
        s.network.proxy_url = "http://p:1".into();
        s.network.no_proxy = vec!["localhost".into()];
        let value = serde_json::to_value(&s).unwrap();
        let all: Vec<String> = SECTIONS.iter().map(|x| (*x).to_owned()).collect();
        let doc = build_export(&value, &all, "x").unwrap();
        let plan = plan_import(&doc, &current()).unwrap();
        assert!(plan.sections.iter().all(|p| !p.invalid), "{plan:?}");
        let mut fresh = current();
        apply_import(&doc, &all, &mut fresh).unwrap();
        assert_eq!(fresh.network, s.network);
    }

    #[test]
    fn long_values_are_cut_in_the_preview() {
        let long = "x".repeat(200);
        assert_eq!(shown(&json!(long)).chars().count(), SHOWN_MAX + 1);
    }
}
