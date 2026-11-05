//! Reads the user's Ghostty or Kitty config and offers the settings that map onto
//! `TerminalSettings` (font, cursor, padding, opacity, scrollback and colours). Nothing is written
//! here except an imported colour scheme, saved like any other custom scheme.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tauri::{AppHandle, Manager, State};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};
use crate::settings::{CursorStyle, SettingsSection, TerminalSettings};
use crate::settings_store;
use crate::terminal_themes::{self, CustomScheme, OnNameTaken};

/// The largest config read, in bytes.
pub const CONFIG_MAX: u64 = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum ConfigKind {
    Ghostty,
    Kitty,
}

impl ConfigKind {
    fn label(self) -> &'static str {
        match self {
            ConfigKind::Ghostty => "Ghostty",
            ConfigKind::Kitty => "Kitty",
        }
    }
}

/// Which configs exist on this machine; the path is the first one found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TermConfigDetected {
    pub ghostty: Option<String>,
    pub kitty: Option<String>,
}

/// The settings a config sets; a field the file does not set (or that has no match here) is null.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TermConfigPreview {
    pub kind: ConfigKind,
    pub path: String,
    pub font_family: Option<String>,
    pub font_size: Option<u8>,
    pub cursor_style: Option<CursorStyle>,
    pub cursor_blink: Option<bool>,
    pub scrollback: Option<u32>,
    pub padding_px: Option<u8>,
    pub background_opacity: Option<f32>,
    /// A named theme the config points at; its colours are not read.
    pub theme_name: Option<String>,
    /// The colours the file sets, the rest filled with defaults; null when it sets none.
    pub scheme: Option<CustomScheme>,
}

/// The 16 ANSI slots, foreground, background, cursor and selection, as `#rrggbb`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Colours {
    pub palette: [Option<String>; 16],
    pub foreground: Option<String>,
    pub background: Option<String>,
    pub cursor: Option<String>,
    pub selection: Option<String>,
}

impl Colours {
    fn any(&self) -> bool {
        self.palette.iter().any(Option::is_some)
            || self.foreground.is_some()
            || self.background.is_some()
            || self.cursor.is_some()
            || self.selection.is_some()
    }
}

/// What a parse found.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Parsed {
    pub font_family: Option<String>,
    pub font_size: Option<u8>,
    pub cursor_style: Option<CursorStyle>,
    pub cursor_blink: Option<bool>,
    pub scrollback: Option<u32>,
    pub padding_px: Option<u8>,
    pub background_opacity: Option<f32>,
    pub theme_name: Option<String>,
    pub colours: Colours,
}

// ---- Locations ----

/// The config files to look for, best first. `xdg` is `$XDG_CONFIG_HOME`.
pub fn candidates(kind: ConfigKind, home: &Path, xdg: Option<&Path>, macos: bool) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let dotconfig = home.join(".config");
    match kind {
        ConfigKind::Ghostty => {
            if let Some(x) = xdg.filter(|x| x.has_root()) {
                out.push(x.join("ghostty").join("config"));
            }
            out.push(dotconfig.join("ghostty").join("config"));
            if macos {
                out.push(
                    home.join("Library")
                        .join("Application Support")
                        .join("com.mitchellh.ghostty")
                        .join("config"),
                );
            }
        }
        ConfigKind::Kitty => {
            if let Some(x) = xdg.filter(|x| x.has_root()) {
                out.push(x.join("kitty").join("kitty.conf"));
            }
            out.push(dotconfig.join("kitty").join("kitty.conf"));
            if macos {
                out.push(
                    home.join("Library")
                        .join("Application Support")
                        .join("kitty")
                        .join("kitty.conf"),
                );
            }
        }
    }
    out
}

fn first_existing(
    kind: ConfigKind,
    home: &Path,
    xdg: Option<&Path>,
    macos: bool,
) -> Option<PathBuf> {
    candidates(kind, home, xdg, macos)
        .into_iter()
        .find(|p| p.is_file())
}

pub fn detect(home: &Path, xdg: Option<&Path>, macos: bool) -> TermConfigDetected {
    let found = |k| first_existing(k, home, xdg, macos).map(|p| p.to_string_lossy().into_owned());
    TermConfigDetected {
        ghostty: found(ConfigKind::Ghostty),
        kitty: found(ConfigKind::Kitty),
    }
}

// ---- Parsing ----

fn hex(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let with = if raw.starts_with('#') {
        raw.to_string()
    } else {
        format!("#{raw}")
    };
    terminal_themes::normalize_hex(&with)
}

fn unquote(v: &str) -> &str {
    let v = v.trim();
    let b = v.as_bytes();
    if b.len() >= 2 && (b[0] == b'"' || b[0] == b'\'') && b[b.len() - 1] == b[0] {
        &v[1..v.len() - 1]
    } else {
        v
    }
}

fn size(raw: &str) -> Option<u8> {
    let n: f32 = raw.trim().parse().ok()?;
    n.is_finite().then(|| {
        n.round().clamp(
            f32::from(*TerminalSettings::FONT_SIZE.start()),
            f32::from(*TerminalSettings::FONT_SIZE.end()),
        ) as u8
    })
}

fn padding(raw: &str) -> Option<u8> {
    let first = raw.split([',', ' ', '\t']).find(|s| !s.is_empty())?;
    let n: f32 = first.parse().ok()?;
    n.is_finite().then(|| {
        n.round().clamp(
            f32::from(*TerminalSettings::PADDING_PX.start()),
            f32::from(*TerminalSettings::PADDING_PX.end()),
        ) as u8
    })
}

fn opacity(raw: &str) -> Option<f32> {
    let n: f32 = raw.trim().parse().ok()?;
    n.is_finite().then(|| {
        n.clamp(
            *TerminalSettings::BG_OPACITY.start(),
            *TerminalSettings::BG_OPACITY.end(),
        )
    })
}

fn flag(raw: &str) -> Option<bool> {
    match raw.trim() {
        "true" | "yes" | "on" => Some(true),
        "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

/// `Ghostty`: `key = value` lines; `#` starts a comment line; `palette = N=#hex`.
pub fn parse_ghostty(text: &str) -> Parsed {
    let mut p = Parsed::default();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let (key, value) = (key.trim(), unquote(value));
        match key {
            // The first family listed is the primary one.
            "font-family" if p.font_family.is_none() && !value.is_empty() => {
                p.font_family = Some(value.to_string());
            }
            "font-size" => p.font_size = size(value).or(p.font_size),
            "cursor-style" => {
                p.cursor_style = match value {
                    "block" | "block_hollow" => Some(CursorStyle::Block),
                    "bar" => Some(CursorStyle::Bar),
                    "underline" => Some(CursorStyle::Underline),
                    _ => p.cursor_style,
                }
            }
            "cursor-style-blink" => p.cursor_blink = flag(value).or(p.cursor_blink),
            "window-padding-x" => p.padding_px = padding(value).or(p.padding_px),
            "background-opacity" => p.background_opacity = opacity(value).or(p.background_opacity),
            "theme" if !value.is_empty() => p.theme_name = Some(value.to_string()),
            "background" => p.colours.background = hex(value).or(p.colours.background.take()),
            "foreground" => p.colours.foreground = hex(value).or(p.colours.foreground.take()),
            "cursor-color" => p.colours.cursor = hex(value).or(p.colours.cursor.take()),
            "selection-background" => {
                p.colours.selection = hex(value).or(p.colours.selection.take());
            }
            "palette" => {
                if let Some((n, c)) = value.split_once('=')
                    && let (Ok(n), Some(c)) = (n.trim().parse::<usize>(), hex(c))
                    && n < 16
                {
                    p.colours.palette[n] = Some(c);
                }
            }
            _ => {}
        }
    }
    p
}

/// `Kitty`: `key value` lines; `#` starts a comment line; `include` lines are not followed.
pub fn parse_kitty(text: &str) -> Parsed {
    let mut p = Parsed::default();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = match line.split_once(char::is_whitespace) {
            Some((k, v)) => (k, v.trim()),
            None => (line, ""),
        };
        match key {
            "font_family" if !value.is_empty() && value != "auto" => {
                p.font_family = Some(value.to_string());
            }
            "font_size" => p.font_size = size(value).or(p.font_size),
            "cursor_shape" => {
                p.cursor_style = match value {
                    "block" => Some(CursorStyle::Block),
                    "beam" => Some(CursorStyle::Bar),
                    "underline" => Some(CursorStyle::Underline),
                    _ => p.cursor_style,
                }
            }
            // Zero turns blinking off; any other interval blinks.
            "cursor_blink_interval" => {
                if let Some(first) = value.split_whitespace().next()
                    && let Ok(n) = first.parse::<f32>()
                {
                    p.cursor_blink = Some(n != 0.0);
                }
            }
            "scrollback_lines" => {
                if let Ok(n) = value.parse::<i64>()
                    && n >= 0
                {
                    p.scrollback = Some(n.min(i64::from(TerminalSettings::MAX_SCROLLBACK)) as u32);
                }
            }
            "window_padding_width" => p.padding_px = padding(value).or(p.padding_px),
            "background_opacity" => p.background_opacity = opacity(value).or(p.background_opacity),
            "background" => p.colours.background = hex(value).or(p.colours.background.take()),
            "foreground" => p.colours.foreground = hex(value).or(p.colours.foreground.take()),
            "cursor" => p.colours.cursor = hex(value).or(p.colours.cursor.take()),
            "selection_background" => {
                p.colours.selection = hex(value).or(p.colours.selection.take());
            }
            k => {
                if let Some(n) = k
                    .strip_prefix("color")
                    .and_then(|n| n.parse::<usize>().ok())
                    && n < 16
                    && let Some(c) = hex(value)
                {
                    p.colours.palette[n] = Some(c);
                }
            }
        }
    }
    p
}

const KEYS: [&str; 16] = [
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
    "brightBlack",
    "brightRed",
    "brightGreen",
    "brightYellow",
    "brightBlue",
    "brightMagenta",
    "brightCyan",
    "brightWhite",
];

/// What fills a slot the config leaves out.
const DEFAULT_PALETTE: [&str; 16] = [
    "#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
    "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff",
];

/// A scheme from the colours, or `None` when the file sets none.
pub fn build_scheme(name: &str, c: &Colours) -> Option<CustomScheme> {
    if !c.any() {
        return None;
    }
    let mut doc = Map::new();
    doc.insert("format".into(), json!(terminal_themes::FORMAT));
    doc.insert("version".into(), json!(1));
    doc.insert("name".into(), json!(name));
    doc.insert(
        "foreground".into(),
        json!(c.foreground.as_deref().unwrap_or("#d0d0d0")),
    );
    doc.insert(
        "background".into(),
        json!(c.background.as_deref().unwrap_or("#000000")),
    );
    if let Some(v) = &c.cursor {
        doc.insert("cursor".into(), json!(v));
    }
    if let Some(v) = &c.selection {
        doc.insert("selectionBackground".into(), json!(v));
    }
    for (i, key) in KEYS.iter().enumerate() {
        let v = c.palette[i].as_deref().unwrap_or(DEFAULT_PALETTE[i]);
        doc.insert((*key).into(), json!(v));
    }
    terminal_themes::parse(Value::Object(doc).to_string().as_bytes())
        .ok()
        .map(|(s, _)| s)
}

fn scheme_name(kind: ConfigKind) -> String {
    format!("{} import", kind.label())
}

fn preview_of(kind: ConfigKind, path: &Path, p: Parsed) -> TermConfigPreview {
    TermConfigPreview {
        kind,
        path: path.to_string_lossy().into_owned(),
        scheme: build_scheme(&scheme_name(kind), &p.colours),
        font_family: p.font_family,
        font_size: p.font_size,
        cursor_style: p.cursor_style,
        cursor_blink: p.cursor_blink,
        scrollback: p.scrollback,
        padding_px: p.padding_px,
        background_opacity: p.background_opacity,
        theme_name: p.theme_name,
    }
}

fn not_found() -> CmdError {
    CmdError {
        code: "not_found",
        detail: None,
    }
}

fn read_text(path: &Path) -> Result<String, CmdError> {
    if !path.metadata().is_ok_and(|m| m.is_file()) {
        return Err(not_found());
    }
    let file = fs::File::open(path).map_err(|e| CmdError {
        code: if e.kind() == std::io::ErrorKind::NotFound {
            "not_found"
        } else {
            "io"
        },
        detail: None,
    })?;
    let mut bytes = Vec::new();
    file.take(CONFIG_MAX + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| CmdError {
            code: "io",
            detail: Some(e.kind().to_string()),
        })?;
    if bytes.len() as u64 > CONFIG_MAX {
        return Err(CmdError {
            code: "io",
            detail: Some("too large".into()),
        });
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Reads `path`, or the first config of `kind` found under `home`.
pub fn read(
    kind: ConfigKind,
    path: Option<&Path>,
    home: &Path,
    xdg: Option<&Path>,
    macos: bool,
) -> Result<TermConfigPreview, CmdError> {
    let path = match path {
        Some(p) => p.to_path_buf(),
        None => first_existing(kind, home, xdg, macos).ok_or_else(not_found)?,
    };
    let text = read_text(&path)?;
    let parsed = match kind {
        ConfigKind::Ghostty => parse_ghostty(&text),
        ConfigKind::Kitty => parse_kitty(&text),
    };
    Ok(preview_of(kind, &path, parsed))
}

// ---- Commands ----

fn env_home(app: &AppHandle) -> Result<PathBuf, CmdError> {
    app.path().home_dir().map_err(|_| not_found())
}

fn env_xdg() -> Option<PathBuf> {
    std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from)
}

#[tauri::command(async)]
pub fn term_config_detect(app: AppHandle) -> TermConfigDetected {
    match env_home(&app) {
        Ok(home) => detect(&home, env_xdg().as_deref(), cfg!(target_os = "macos")),
        Err(_) => TermConfigDetected {
            ghostty: None,
            kitty: None,
        },
    }
}

#[tauri::command(async)]
pub fn term_config_read(
    app: AppHandle,
    kind: ConfigKind,
    path: Option<String>,
) -> Result<TermConfigPreview, CmdError> {
    read(
        kind,
        path.as_deref().map(Path::new),
        &env_home(&app)?,
        env_xdg().as_deref(),
        cfg!(target_os = "macos"),
    )
}

/// Saves the config's colours as a custom scheme named "<Kind> import", replacing the one an
/// earlier import left.
#[tauri::command(async)]
pub fn term_config_save_scheme(
    app: AppHandle,
    state: State<'_, AppState>,
    kind: ConfigKind,
    path: Option<String>,
) -> Result<CustomScheme, CmdError> {
    let preview = term_config_read(app.clone(), kind, path)?;
    let scheme = preview.scheme.ok_or(CmdError {
        code: "theme_invalid",
        detail: Some("file".into()),
    })?;
    let dir = data_dir(&state).map(terminal_themes::themes_dir)?;
    let saved = terminal_themes::save(&dir, scheme, OnNameTaken::Replace)?;
    settings_store::emit_changed(&app, &[SettingsSection::Terminal]);
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GHOSTTY: &str = "# comment\nfont-family = \"JetBrains Mono\"\nfont-family = Fira\nfont-size = 13.5\ncursor-style = bar\ncursor-style-blink = false\nwindow-padding-x = 6,8\nbackground-opacity = 0.9\ntheme = catppuccin-mocha\nbackground = 1e1e2e\nforeground = #cdd6f4\ncursor-color = #f5e0dc\nselection-background = #585b70\npalette = 0=#45475a\npalette = 15=#a6adc8\npalette = 16=#ffffff\nscrollback-limit = 10000000\n";

    const KITTY: &str = "# c\ninclude other.conf\nfont_family Fira Code\nfont_size 11\ncursor_shape beam\ncursor_blink_interval 0\nscrollback_lines 5000\nwindow_padding_width 4 8\nbackground_opacity 0.8\nforeground #ddd\nbackground #101010\ncolor0 #000000\ncolor9 #ff0000\ncolor16 #123456\n";

    #[test]
    fn ghostty_keys_map() {
        let p = parse_ghostty(GHOSTTY);
        assert_eq!(p.font_family.as_deref(), Some("JetBrains Mono"));
        assert_eq!(p.font_size, Some(14));
        assert_eq!(p.cursor_style, Some(CursorStyle::Bar));
        assert_eq!(p.cursor_blink, Some(false));
        assert_eq!(p.padding_px, Some(6));
        assert_eq!(p.background_opacity, Some(0.9));
        assert_eq!(p.theme_name.as_deref(), Some("catppuccin-mocha"));
        assert_eq!(p.colours.background.as_deref(), Some("#1e1e2e"));
        assert_eq!(p.colours.foreground.as_deref(), Some("#cdd6f4"));
        assert_eq!(p.colours.cursor.as_deref(), Some("#f5e0dc"));
        assert_eq!(p.colours.palette[0].as_deref(), Some("#45475a"));
        assert_eq!(p.colours.palette[15].as_deref(), Some("#a6adc8"));
        assert_eq!(p.scrollback, None);
    }

    #[test]
    fn kitty_keys_map() {
        let p = parse_kitty(KITTY);
        assert_eq!(p.font_family.as_deref(), Some("Fira Code"));
        assert_eq!(p.font_size, Some(11));
        assert_eq!(p.cursor_style, Some(CursorStyle::Bar));
        assert_eq!(p.cursor_blink, Some(false));
        assert_eq!(p.scrollback, Some(5000));
        assert_eq!(p.padding_px, Some(4));
        assert_eq!(p.background_opacity, Some(0.8));
        assert_eq!(p.colours.foreground.as_deref(), Some("#dddddd"));
        assert_eq!(p.colours.palette[9].as_deref(), Some("#ff0000"));
        assert!(p.colours.palette.iter().filter(|c| c.is_some()).count() == 2);
    }

    #[test]
    fn values_are_clamped_to_the_settings_ranges() {
        let p = parse_ghostty("font-size = 200\nwindow-padding-x = 99\nbackground-opacity = 0.1\n");
        assert_eq!(p.font_size, Some(32));
        assert_eq!(p.padding_px, Some(24));
        assert_eq!(p.background_opacity, Some(0.5));
        let k = parse_kitty("scrollback_lines -1\nscrollback_lines 999999999\n");
        assert_eq!(k.scrollback, Some(TerminalSettings::MAX_SCROLLBACK));
    }

    #[test]
    fn a_config_with_no_colours_has_no_scheme() {
        assert!(build_scheme("x", &parse_kitty("font_size 12\n").colours).is_none());
        let s = build_scheme("Kitty import", &parse_kitty(KITTY).colours).unwrap();
        assert_eq!(s.colors.background, "#101010");
        assert_eq!(s.colors.red, DEFAULT_PALETTE[1]);
        assert_eq!(s.colors.bright_red, "#ff0000");
    }

    #[test]
    fn candidates_follow_the_platform() {
        let home = Path::new("/home/u");
        let xdg = Path::new("/xdg");
        let g = candidates(ConfigKind::Ghostty, home, Some(xdg), true);
        assert_eq!(g[0], xdg.join("ghostty").join("config"));
        assert_eq!(g[1], home.join(".config").join("ghostty").join("config"));
        assert!(g[2].to_string_lossy().contains("com.mitchellh.ghostty"));
        assert_eq!(candidates(ConfigKind::Kitty, home, None, false).len(), 1);
    }

    #[test]
    fn detect_and_read_use_the_given_home() {
        let tmp = tempfile::tempdir().unwrap();
        let none = detect(tmp.path(), None, false);
        assert_eq!((none.ghostty, none.kitty), (None, None));
        assert_eq!(
            read(ConfigKind::Kitty, None, tmp.path(), None, false)
                .unwrap_err()
                .code,
            "not_found"
        );
        let dir = tmp.path().join(".config").join("kitty");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("kitty.conf"), KITTY).unwrap();
        let found = detect(tmp.path(), None, false);
        assert!(found.kitty.is_some() && found.ghostty.is_none());
        let p = read(ConfigKind::Kitty, None, tmp.path(), None, false).unwrap();
        assert_eq!(p.font_size, Some(11));
        assert!(p.scheme.is_some());
        let own = tmp.path().join("mine.conf");
        fs::write(&own, "font_size 9\n").unwrap();
        let q = read(ConfigKind::Kitty, Some(&own), tmp.path(), None, false).unwrap();
        assert_eq!(q.font_size, Some(9));
        assert!(q.scheme.is_none());
    }
}
