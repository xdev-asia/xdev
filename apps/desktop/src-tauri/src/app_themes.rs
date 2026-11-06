//! App colour themes a person makes or imports (`xdev-app-theme`, version 1).
//!
//! `parse` is pure. The store under `<data_dir>/app-themes/` is below it. A theme names token keys
//! (`surface-0`, `text-1` ...) and gives `#rrggbb` values per mode; the UI knows which keys exist,
//! so this module only checks their shape. `terminalScheme` optionally names a terminal colour
//! scheme the theme switches to.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::State;

use crate::accounts::data_dir;
use crate::atomic::write_atomic;
use crate::commands::{AppState, CmdError};
use crate::terminal_themes::{
    OnNameTaken, SLUG_MAX, THEME_FILE_MAX, THEME_NAME_MAX, ThemeError, Trash, file_of, io_error,
    normalize_hex, not_found, read_capped, slug, trash_file, valid_stem,
};

/// The format tag a theme file carries.
pub const FORMAT: &str = "xdev-app-theme";
/// The most colours one mode of a theme holds.
pub const KEYS_MAX: usize = 40;
const KEY_MAX: usize = 32;
const SCHEME_ID_MAX: usize = 40;

/// A stored theme. `id` is the file stem.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AppTheme {
    pub id: String,
    pub name: String,
    pub dark: BTreeMap<String, String>,
    pub light: BTreeMap<String, String>,
    /// A terminal colour scheme id this theme switches to; absent keeps the person's own.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub terminal_scheme: Option<String>,
}

/// What the editor saves. `id: None` makes a new theme; `Some` overwrites (and may rename) it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AppThemeInput {
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub dark: BTreeMap<String, String>,
    #[serde(default)]
    pub light: BTreeMap<String, String>,
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub terminal_scheme: Option<String>,
}

fn key_ok(key: &str) -> bool {
    (1..=KEY_MAX).contains(&key.len())
        && key
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn scheme_id_ok(id: &str) -> bool {
    (1..=SCHEME_ID_MAX).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Checks and normalises one mode's colours.
fn colours(
    raw: &BTreeMap<String, String>,
    mode: &str,
) -> Result<BTreeMap<String, String>, ThemeError> {
    if raw.len() > KEYS_MAX {
        return Err(ThemeError::invalid(mode));
    }
    let mut out = BTreeMap::new();
    for (key, value) in raw {
        if !key_ok(key) {
            return Err(ThemeError::invalid(key));
        }
        let hex = normalize_hex(value).ok_or_else(|| ThemeError::invalid(key))?;
        out.insert(key.clone(), hex);
    }
    Ok(out)
}

fn clean_name(raw: &str) -> Result<String, ThemeError> {
    let name = raw.trim();
    if name.is_empty()
        || name.chars().count() > THEME_NAME_MAX
        || name.chars().any(char::is_control)
    {
        return Err(ThemeError::invalid("name"));
    }
    Ok(name.to_string())
}

/// Checks an input as `parse` checks a file: the name, every key and value, the scheme id.
fn checked(input: &AppThemeInput) -> Result<AppThemeInput, ThemeError> {
    let scheme = match &input.terminal_scheme {
        None => None,
        Some(s) if scheme_id_ok(s) => Some(s.clone()),
        Some(_) => return Err(ThemeError::invalid("terminalScheme")),
    };
    Ok(AppThemeInput {
        id: input.id.clone(),
        name: clean_name(&input.name)?,
        dark: colours(&input.dark, "dark")?,
        light: colours(&input.light, "light")?,
        terminal_scheme: scheme,
    })
}

/// Parse a theme file. Returns the theme (`id` is `None`) and the top-level keys this build
/// ignores. Colour keys are not matched against a list: the UI ignores the ones it does not know.
pub fn parse(bytes: &[u8]) -> Result<(AppThemeInput, Vec<String>), ThemeError> {
    if bytes.len() as u64 > THEME_FILE_MAX {
        return Err(ThemeError {
            code: "theme_too_large",
            field: None,
        });
    }
    let Ok(Value::Object(obj)) = serde_json::from_slice::<Value>(bytes) else {
        return Err(ThemeError::invalid("file"));
    };
    if obj.get("format").and_then(Value::as_str) != Some(FORMAT) {
        return Err(ThemeError::invalid("format"));
    }
    if obj.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(ThemeError::invalid("version"));
    }
    let name = obj
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| ThemeError::invalid("name"))?;
    let mode = |key: &str| -> Result<BTreeMap<String, String>, ThemeError> {
        match obj.get(key) {
            None | Some(Value::Null) => Ok(BTreeMap::new()),
            Some(Value::Object(map)) => {
                let mut raw = BTreeMap::new();
                for (k, v) in map {
                    let s = v.as_str().ok_or_else(|| ThemeError::invalid(k))?;
                    raw.insert(k.clone(), s.to_string());
                }
                Ok(raw)
            }
            Some(_) => Err(ThemeError::invalid(key)),
        }
    };
    let terminal_scheme = match obj.get("terminalScheme") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => return Err(ThemeError::invalid("terminalScheme")),
    };
    let input = checked(&AppThemeInput {
        id: None,
        name: name.to_string(),
        dark: mode("dark")?,
        light: mode("light")?,
        terminal_scheme,
    })?;
    let mut ignored: Vec<String> = obj
        .keys()
        .filter(|k| {
            ![
                "format",
                "version",
                "name",
                "dark",
                "light",
                "terminalScheme",
            ]
            .contains(&k.as_str())
        })
        .cloned()
        .collect();
    ignored.sort();
    Ok((input, ignored))
}

// ---- Store: `<data_dir>/app-themes/<slug>.json` ----

/// The folder the themes live in.
pub fn themes_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("app-themes")
}

fn name_taken(existing: String) -> CmdError {
    CmdError {
        code: "name_taken",
        detail: Some(existing),
    }
}

/// The file as stored and exported.
fn stored_bytes(theme: &AppThemeInput) -> Vec<u8> {
    let mut doc = Map::new();
    doc.insert("format".into(), FORMAT.into());
    doc.insert("version".into(), 1.into());
    doc.insert("name".into(), theme.name.clone().into());
    for (key, map) in [("dark", &theme.dark), ("light", &theme.light)] {
        if !map.is_empty() {
            doc.insert(key.into(), serde_json::to_value(map).unwrap_or_default());
        }
    }
    if let Some(s) = &theme.terminal_scheme {
        doc.insert("terminalScheme".into(), s.clone().into());
    }
    serde_json::to_vec_pretty(&Value::Object(doc)).unwrap_or_default()
}

fn read_stored(dir: &Path, stem: &str) -> Result<AppTheme, CmdError> {
    let (input, _) = parse(&read_capped(&file_of(dir, stem))?)?;
    Ok(AppTheme {
        id: stem.to_string(),
        name: input.name,
        dark: input.dark,
        light: input.light,
        terminal_scheme: input.terminal_scheme,
    })
}

/// Every stored theme, by name. A file that does not parse is skipped.
pub fn list(dir: &Path) -> Vec<AppTheme> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<AppTheme> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                return None;
            }
            let stem = path.file_stem()?.to_str()?;
            if !valid_stem(stem) {
                return None;
            }
            read_stored(dir, stem).ok()
        })
        .collect();
    out.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });
    out
}

fn taken_name(dir: &Path, stem: &str) -> String {
    read_stored(dir, stem).map_or_else(|_| stem.to_string(), |t| t.name)
}

/// Saves what the editor sends. No `id`: a new theme, refused with `name_taken` when the name's
/// file exists. With an `id`: that theme is overwritten, and renamed when the new name is free.
pub fn save(dir: &Path, input: &AppThemeInput) -> Result<AppTheme, CmdError> {
    let input = checked(input)?;
    let stem = slug(&input.name, SLUG_MAX);
    match &input.id {
        None => {
            if file_of(dir, &stem).exists() {
                return Err(name_taken(taken_name(dir, &stem)));
            }
        }
        Some(id) => {
            if !valid_stem(id) || !file_of(dir, id).is_file() {
                return Err(not_found());
            }
            if *id != stem && file_of(dir, &stem).exists() {
                return Err(name_taken(taken_name(dir, &stem)));
            }
        }
    }
    write_atomic(&file_of(dir, &stem), &stored_bytes(&input)).map_err(io_error)?;
    if let Some(old) = input.id.as_deref().filter(|id| *id != stem) {
        // A rename: the old file goes, it is not a deletion the person asked for.
        fs::remove_file(file_of(dir, old)).map_err(io_error)?;
    }
    Ok(AppTheme {
        id: stem,
        name: input.name,
        dark: input.dark,
        light: input.light,
        terminal_scheme: input.terminal_scheme,
    })
}

/// `name` with ` n`, cut so the name stays within `THEME_NAME_MAX`.
fn numbered_name(name: &str, n: u32) -> String {
    let suffix = format!(" {n}");
    let head: String = name
        .chars()
        .take(THEME_NAME_MAX - suffix.chars().count())
        .collect();
    format!("{}{suffix}", head.trim_end())
}

/// Saves the theme in the file at `source`. A name already stored is refused (`name_taken`),
/// replaced in place, or kept beside the old one under `<name> 2`, as `on_taken` says.
pub fn import(dir: &Path, source: &Path, on_taken: OnNameTaken) -> Result<AppTheme, CmdError> {
    let (mut input, _) = parse(&read_capped(source)?)?;
    let mut stem = slug(&input.name, SLUG_MAX);
    if file_of(dir, &stem).exists() {
        match on_taken {
            OnNameTaken::Fail => return Err(name_taken(taken_name(dir, &stem))),
            OnNameTaken::Replace => {}
            OnNameTaken::KeepBoth => {
                let base = input.name.clone();
                let pick = (2u32..).find_map(|n| {
                    let name = numbered_name(&base, n);
                    let s = slug(&name, SLUG_MAX);
                    (!file_of(dir, &s).exists()).then_some((name, s))
                });
                if let Some((name, s)) = pick {
                    input.name = name;
                    stem = s;
                }
            }
        }
    }
    write_atomic(&file_of(dir, &stem), &stored_bytes(&input)).map_err(io_error)?;
    Ok(AppTheme {
        id: stem,
        name: input.name,
        dark: input.dark,
        light: input.light,
        terminal_scheme: input.terminal_scheme,
    })
}

/// Moves the stored theme `id` to the trash.
pub fn remove(dir: &Path, id: &str, trash: Trash) -> Result<(), CmdError> {
    if !valid_stem(id) {
        return Err(not_found());
    }
    let path = file_of(dir, id);
    if !path.is_file() {
        return Err(not_found());
    }
    trash(&path).map_err(io_error)
}

/// The text `app_theme_export` writes for the stored theme `id`.
pub fn export_text(dir: &Path, id: &str) -> Result<String, CmdError> {
    if !valid_stem(id) {
        return Err(not_found());
    }
    let theme = read_stored(dir, id)?;
    let input = AppThemeInput {
        id: None,
        name: theme.name,
        dark: theme.dark,
        light: theme.light,
        terminal_scheme: theme.terminal_scheme,
    };
    Ok(String::from_utf8(stored_bytes(&input)).unwrap_or_default())
}

// ---- Commands ----

fn dir_of(state: &AppState) -> Result<PathBuf, CmdError> {
    data_dir(state).map(themes_dir)
}

#[tauri::command(async)]
pub fn app_themes_list(state: State<'_, AppState>) -> Result<Vec<AppTheme>, CmdError> {
    Ok(list(&dir_of(&state)?))
}

#[tauri::command(async)]
pub fn app_theme_save(
    state: State<'_, AppState>,
    theme: AppThemeInput,
) -> Result<AppTheme, CmdError> {
    save(&dir_of(&state)?, &theme)
}

#[tauri::command(async)]
pub fn app_theme_remove(state: State<'_, AppState>, id: String) -> Result<(), CmdError> {
    remove(&dir_of(&state)?, &id, &trash_file)
}

#[tauri::command(async)]
pub fn app_theme_import(
    state: State<'_, AppState>,
    path: String,
    on_taken: OnNameTaken,
) -> Result<AppTheme, CmdError> {
    import(&dir_of(&state)?, Path::new(&path), on_taken)
}

/// Asks where to save in a native dialog opened here, then writes the theme. `None` means the
/// person cancelled; otherwise the path written.
#[tauri::command(async)]
pub fn app_theme_export(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<String>, CmdError> {
    use tauri_plugin_dialog::DialogExt;
    let text = export_text(&dir_of(&state)?, &id)?;
    let Some(picked) = app
        .dialog()
        .file()
        .set_file_name(format!("{id}.xdev-theme.json"))
        .add_filter("JSON", &["json"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let mut path: PathBuf = picked.into_path().map_err(|e| CmdError {
        code: "io",
        detail: Some(e.to_string()),
    })?;
    if path.extension().and_then(|e| e.to_str()) != Some("json") {
        path.set_extension("json");
    }
    write_atomic(&path, text.as_bytes()).map_err(io_error)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io;

    fn file() -> Value {
        json!({
            "format": "xdev-app-theme", "version": 1, "name": "Dusk",
            "dark": { "surface-0": "#0B0D12", "text-1": "#e8e8ec", "accent": "#36f" },
            "light": { "accent": "#2453d6" }
        })
    }

    fn parse_value(v: &Value) -> Result<(AppThemeInput, Vec<String>), ThemeError> {
        parse(v.to_string().as_bytes())
    }

    fn input(name: &str) -> AppThemeInput {
        AppThemeInput {
            id: None,
            name: name.to_string(),
            dark: BTreeMap::from([("accent".to_string(), "#3a6df0".to_string())]),
            light: BTreeMap::new(),
            terminal_scheme: None,
        }
    }

    fn fake_trash(path: &Path) -> io::Result<()> {
        fs::remove_file(path)
    }

    fn write_theme(dir: &Path, name: &str, v: &Value) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, v.to_string()).unwrap();
        path
    }

    #[test]
    fn a_valid_file_parses_and_normalises() {
        let (t, ignored) = parse_value(&file()).unwrap();
        assert_eq!(t.name, "Dusk");
        assert_eq!(t.dark["surface-0"], "#0b0d12");
        assert_eq!(t.dark["accent"], "#3366ff");
        assert_eq!(t.light["accent"], "#2453d6");
        assert_eq!(t.terminal_scheme, None);
        assert!(ignored.is_empty());
    }

    #[test]
    fn a_minimal_file_parses() {
        let (t, _) =
            parse_value(&json!({"format": "xdev-app-theme", "version": 1, "name": "Min"})).unwrap();
        assert!(t.dark.is_empty() && t.light.is_empty());
    }

    #[test]
    fn the_terminal_scheme_is_carried_by_name() {
        let mut v = file();
        v["terminalScheme"] = json!("custom-graphite-dark");
        let (t, _) = parse_value(&v).unwrap();
        assert_eq!(t.terminal_scheme.as_deref(), Some("custom-graphite-dark"));
        v["terminalScheme"] = json!("../x");
        assert_eq!(parse_value(&v), Err(ThemeError::invalid("terminalScheme")));
        v["terminalScheme"] = json!(7);
        assert_eq!(parse_value(&v), Err(ThemeError::invalid("terminalScheme")));
    }

    #[test]
    fn a_big_file_is_too_large() {
        let big = vec![b' '; THEME_FILE_MAX as usize + 1];
        assert_eq!(parse(&big).unwrap_err().code, "theme_too_large");
    }

    #[test]
    fn a_wrong_format_or_version_is_refused() {
        let mut v = file();
        v["format"] = json!("xdev-terminal-theme");
        assert_eq!(parse_value(&v), Err(ThemeError::invalid("format")));
        let mut v = file();
        v["version"] = json!(2);
        assert_eq!(parse_value(&v), Err(ThemeError::invalid("version")));
        assert_eq!(parse(b"nope"), Err(ThemeError::invalid("file")));
        assert_eq!(parse(b"[1]"), Err(ThemeError::invalid("file")));
    }

    #[test]
    fn a_bad_colour_names_its_key() {
        for bad in ["red", "#12345", "#fff;}", "url(x)", ""] {
            let mut v = file();
            v["dark"]["text-1"] = json!(bad);
            assert_eq!(parse_value(&v), Err(ThemeError::invalid("text-1")), "{bad}");
        }
        let mut v = file();
        v["light"]["Bad Key"] = json!("#fff");
        assert_eq!(parse_value(&v), Err(ThemeError::invalid("Bad Key")));
    }

    #[test]
    fn at_most_forty_keys_per_mode() {
        let many = |n: usize| -> Value {
            let mut m = Map::new();
            for i in 0..n {
                m.insert(format!("k{i}"), json!("#fff"));
            }
            Value::Object(m)
        };
        let mut v = file();
        v["dark"] = many(KEYS_MAX);
        assert!(parse_value(&v).is_ok());
        v["dark"] = many(KEYS_MAX + 1);
        assert_eq!(parse_value(&v), Err(ThemeError::invalid("dark")));
    }

    #[test]
    fn the_name_is_trimmed_and_capped() {
        let mut v = file();
        v["name"] = json!("  Night  ");
        assert_eq!(parse_value(&v).unwrap().0.name, "Night");
        v["name"] = json!("a".repeat(THEME_NAME_MAX));
        assert!(parse_value(&v).is_ok());
        v["name"] = json!("a".repeat(THEME_NAME_MAX + 1));
        assert_eq!(parse_value(&v), Err(ThemeError::invalid("name")));
        v["name"] = json!("   ");
        assert_eq!(parse_value(&v), Err(ThemeError::invalid("name")));
    }

    #[test]
    fn unknown_top_level_keys_are_listed() {
        let mut v = file();
        v["zebra"] = json!(1);
        assert_eq!(parse_value(&v).unwrap().1, vec!["zebra".to_string()]);
    }

    #[test]
    fn save_new_then_the_same_name_is_taken() {
        let dir = tempfile::tempdir().unwrap();
        let saved = save(dir.path(), &input("Night")).unwrap();
        assert_eq!(saved.id, "night");
        assert_eq!(list(dir.path()), vec![saved]);
        let err = save(dir.path(), &input("night")).unwrap_err();
        assert_eq!(
            (err.code, err.detail.as_deref()),
            ("name_taken", Some("Night"))
        );
    }

    #[test]
    fn save_with_an_id_overwrites_and_renames() {
        let dir = tempfile::tempdir().unwrap();
        let first = save(dir.path(), &input("Night")).unwrap();
        let mut edit = input("Night");
        edit.id = Some(first.id.clone());
        edit.dark.insert("text-1".into(), "#ffffff".into());
        let again = save(dir.path(), &edit).unwrap();
        assert_eq!(again.id, "night");
        assert_eq!(again.dark["text-1"], "#ffffff");
        assert_eq!(list(dir.path()).len(), 1);

        edit.name = "Midnight".into();
        let renamed = save(dir.path(), &edit).unwrap();
        assert_eq!(renamed.id, "midnight");
        let all = list(dir.path());
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "Midnight");

        // A rename onto another theme's name is refused.
        save(dir.path(), &input("Dawn")).unwrap();
        edit.id = Some("midnight".into());
        edit.name = "Dawn".into();
        assert_eq!(save(dir.path(), &edit).unwrap_err().code, "name_taken");
        // An id that is not stored.
        edit.id = Some("ghost".into());
        assert_eq!(save(dir.path(), &edit).unwrap_err().code, "not_found");
        edit.id = Some("../x".into());
        assert_eq!(save(dir.path(), &edit).unwrap_err().code, "not_found");
    }

    #[test]
    fn save_refuses_a_bad_input() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            save(dir.path(), &input("  ")).unwrap_err().code,
            "theme_invalid"
        );
        let mut bad = input("X");
        bad.dark.insert("accent".into(), "red".into());
        let err = save(dir.path(), &bad).unwrap_err();
        assert_eq!(
            (err.code, err.detail.as_deref()),
            ("theme_invalid", Some("accent"))
        );
    }

    #[test]
    fn import_keep_both_adds_a_number() {
        let dir = tempfile::tempdir().unwrap();
        let src = write_theme(dir.path(), "in.json", &file());
        let store = dir.path().join("store");
        let a = import(&store, &src, OnNameTaken::Fail).unwrap();
        assert_eq!((a.id.as_str(), a.name.as_str()), ("dusk", "Dusk"));
        assert_eq!(
            import(&store, &src, OnNameTaken::Fail).unwrap_err().code,
            "name_taken"
        );
        let b = import(&store, &src, OnNameTaken::KeepBoth).unwrap();
        assert_eq!((b.id.as_str(), b.name.as_str()), ("dusk-2", "Dusk 2"));
        let c = import(&store, &src, OnNameTaken::KeepBoth).unwrap();
        assert_eq!(c.name, "Dusk 3");
        let r = import(&store, &src, OnNameTaken::Replace).unwrap();
        assert_eq!(r.id, "dusk");
        assert_eq!(list(&store).len(), 3);
    }

    #[test]
    fn list_skips_a_broken_file() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), &input("Night")).unwrap();
        fs::write(dir.path().join("broken.json"), "{").unwrap();
        fs::write(dir.path().join("Bad Stem.json"), file().to_string()).unwrap();
        fs::write(dir.path().join("note.txt"), "x").unwrap();
        let all = list(dir.path());
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "Night");
        assert!(list(&dir.path().join("missing")).is_empty());
    }

    #[test]
    fn remove_trashes_only_a_stored_theme() {
        let dir = tempfile::tempdir().unwrap();
        let t = save(dir.path(), &input("Night")).unwrap();
        for bad in ["../night", "ghost", ""] {
            assert_eq!(
                remove(dir.path(), bad, &fake_trash).unwrap_err().code,
                "not_found"
            );
        }
        remove(dir.path(), &t.id, &fake_trash).unwrap();
        assert!(list(dir.path()).is_empty());
    }

    #[test]
    fn export_text_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let mut i = input("Night");
        i.terminal_scheme = Some("custom-graphite-dark".into());
        let t = save(dir.path(), &i).unwrap();
        let text = export_text(dir.path(), &t.id).unwrap();
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["format"], "xdev-app-theme");
        assert_eq!(v["version"], 1);
        assert_eq!(v["terminalScheme"], "custom-graphite-dark");
        let (back, _) = parse(text.as_bytes()).unwrap();
        assert_eq!(back.dark, t.dark);
        assert_eq!(
            export_text(dir.path(), "ghost").unwrap_err().code,
            "not_found"
        );
    }
}
