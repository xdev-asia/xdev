//! Terminal colour schemes a person imports (`xdev-terminal-theme`, version 1).
//!
//! `parse` is pure. The store under `<data_dir>/themes/` is below it.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The largest theme file read, in bytes.
pub const THEME_FILE_MAX: u64 = 64 * 1024;
/// The longest scheme name, in characters.
pub const THEME_NAME_MAX: usize = 60;
/// The format tag a theme file carries.
pub const FORMAT: &str = "xdev-terminal-theme";
/// A foreground / background ratio under this shows a warning.
pub const MIN_CONTRAST: f64 = 3.0;

/// Why a theme file was refused. `code` is a `CmdError` code; `field` is the
/// key at fault (never a path).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThemeError {
    pub code: &'static str,
    pub field: Option<String>,
}

impl ThemeError {
    fn invalid(field: &str) -> Self {
        ThemeError {
            code: "theme_invalid",
            field: Some(field.to_string()),
        }
    }

    fn too_large() -> Self {
        ThemeError {
            code: "theme_too_large",
            field: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum SchemeMode {
    Dark,
    Light,
}

/// The names are those of the terminal component's own theme object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SchemeColors {
    pub background: String,
    pub foreground: String,
    pub cursor: String,
    pub cursor_accent: String,
    pub selection_background: String,
    pub black: String,
    pub red: String,
    pub green: String,
    pub yellow: String,
    pub blue: String,
    pub magenta: String,
    pub cyan: String,
    pub white: String,
    pub bright_black: String,
    pub bright_red: String,
    pub bright_green: String,
    pub bright_yellow: String,
    pub bright_blue: String,
    pub bright_magenta: String,
    pub bright_cyan: String,
    pub bright_white: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CustomScheme {
    /// `custom-<slug>`: passes the terminal setting's id rule.
    pub id: String,
    pub name: String,
    pub mode: SchemeMode,
    pub colors: SchemeColors,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SchemePreview {
    pub scheme: CustomScheme,
    /// Keys of the file this build ignores.
    pub ignored_keys: Vec<String>,
    /// Foreground against background is under 3:1.
    pub low_contrast: bool,
    /// A scheme with this name is already stored.
    pub name_taken: bool,
}

/// What an import does when the name is taken.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum OnNameTaken {
    Fail,
    Replace,
    KeepBoth,
}

/// Keys that are always required, in the order the file lists them.
const REQUIRED: [&str; 18] = [
    "foreground",
    "background",
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
const OPTIONAL: [&str; 3] = ["cursor", "cursorAccent", "selectionBackground"];

/// A `#rgb` or `#rrggbb` colour as lower-case `#rrggbb`; nothing else.
pub fn normalize_hex(raw: &str) -> Option<String> {
    let hex = raw.strip_prefix('#')?;
    if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    match hex.len() {
        3 => {
            let mut out = String::from("#");
            for c in hex.chars() {
                out.push(c.to_ascii_lowercase());
                out.push(c.to_ascii_lowercase());
            }
            Some(out)
        }
        6 => Some(format!("#{}", hex.to_ascii_lowercase())),
        _ => None,
    }
}

fn rgb(hex: &str) -> Option<[f64; 3]> {
    let hex = normalize_hex(hex)?;
    let channel = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).map(f64::from);
    Some([channel(1).ok()?, channel(3).ok()?, channel(5).ok()?])
}

fn luminance(rgb: [f64; 3]) -> f64 {
    let lin = |c: f64| {
        let c = c / 255.0;
        if c <= 0.03928 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2])
}

/// The WCAG contrast ratio of two hex colours, 1.0..=21.0; 1.0 when one does
/// not parse.
pub fn contrast_ratio(fg: &str, bg: &str) -> f64 {
    let (Some(a), Some(b)) = (rgb(fg), rgb(bg)) else {
        return 1.0;
    };
    let (la, lb) = (luminance(a), luminance(b));
    let (hi, lo) = if la >= lb { (la, lb) } else { (lb, la) };
    (hi + 0.05) / (lo + 0.05)
}

/// A quarter of `b` over `a`; the default selection colour.
fn mix(a: &str, b: &str) -> String {
    let (x, y) = (rgb(a).unwrap_or([0.0; 3]), rgb(b).unwrap_or([0.0; 3]));
    let m = |i: usize| (x[i] * 0.75 + y[i] * 0.25).round() as u8;
    format!("#{:02x}{:02x}{:02x}", m(0), m(1), m(2))
}

/// `custom-`-less slug of a name: lower-case ASCII letters and digits, other
/// runs become one `-`; at most `max` characters; `theme` when nothing is left.
pub fn slug(name: &str, max: usize) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let cut: String = out.chars().take(max).collect();
    let cut = cut.trim_end_matches('-');
    if cut.is_empty() {
        "theme".to_string()
    } else {
        cut.to_string()
    }
}

/// The longest slug: `custom-` + slug stays within the id rule's 40.
pub const SLUG_MAX: usize = 33;

/// Parse a theme file. Returns the scheme (id from the name's slug) and the
/// keys that were ignored.
pub fn parse(bytes: &[u8]) -> Result<(CustomScheme, Vec<String>), ThemeError> {
    if bytes.len() as u64 > THEME_FILE_MAX {
        return Err(ThemeError::too_large());
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| ThemeError::invalid("file"))?;
    let obj = value
        .as_object()
        .ok_or_else(|| ThemeError::invalid("file"))?;
    if obj.get("format").and_then(Value::as_str) != Some(FORMAT) {
        return Err(ThemeError::invalid("format"));
    }
    if obj.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(ThemeError::invalid("version"));
    }
    let name = obj
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|n| !n.is_empty() && n.chars().count() <= THEME_NAME_MAX)
        .filter(|n| !n.chars().any(char::is_control))
        .ok_or_else(|| ThemeError::invalid("name"))?
        .to_string();

    let colour = |key: &str| -> Result<Option<String>, ThemeError> {
        match obj.get(key) {
            None => Ok(None),
            Some(v) => v
                .as_str()
                .and_then(normalize_hex)
                .map(Some)
                .ok_or_else(|| ThemeError::invalid(key)),
        }
    };
    let need = |key: &str| colour(key)?.ok_or_else(|| ThemeError::invalid(key));

    // Required keys first, so a missing one is named before an optional one.
    for key in REQUIRED {
        need(key)?;
    }
    let background = need("background")?;
    let foreground = need("foreground")?;
    let cursor = colour("cursor")?.unwrap_or_else(|| foreground.clone());
    let cursor_accent = colour("cursorAccent")?.unwrap_or_else(|| background.clone());
    let selection_background =
        colour("selectionBackground")?.unwrap_or_else(|| mix(&background, &foreground));

    let mode = match obj.get("kind") {
        None => {
            if luminance(rgb(&background).unwrap_or([0.0; 3])) > 0.179 {
                SchemeMode::Light
            } else {
                SchemeMode::Dark
            }
        }
        Some(v) => match v.as_str() {
            Some("dark") => SchemeMode::Dark,
            Some("light") => SchemeMode::Light,
            _ => return Err(ThemeError::invalid("kind")),
        },
    };

    let colors = SchemeColors {
        background,
        foreground,
        cursor,
        cursor_accent,
        selection_background,
        black: need("black")?,
        red: need("red")?,
        green: need("green")?,
        yellow: need("yellow")?,
        blue: need("blue")?,
        magenta: need("magenta")?,
        cyan: need("cyan")?,
        white: need("white")?,
        bright_black: need("brightBlack")?,
        bright_red: need("brightRed")?,
        bright_green: need("brightGreen")?,
        bright_yellow: need("brightYellow")?,
        bright_blue: need("brightBlue")?,
        bright_magenta: need("brightMagenta")?,
        bright_cyan: need("brightCyan")?,
        bright_white: need("brightWhite")?,
    };

    let mut ignored: Vec<String> = obj
        .keys()
        .filter(|k| {
            !["format", "version", "name", "kind"].contains(&k.as_str())
                && !REQUIRED.contains(&k.as_str())
                && !OPTIONAL.contains(&k.as_str())
        })
        .cloned()
        .collect();
    ignored.sort();

    let id = format!("custom-{}", slug(&name, SLUG_MAX));
    Ok((
        CustomScheme {
            id,
            name,
            mode,
            colors,
        },
        ignored,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn file() -> Value {
        json!({
            "format": "xdev-terminal-theme", "version": 1, "name": "Graphite Dark",
            "kind": "dark", "foreground": "#d7dae0", "background": "#14161a",
            "cursor": "#5b8cff", "cursorAccent": "#14161a", "selectionBackground": "#2a3a63",
            "black": "#1b1e24", "red": "#e06c75", "green": "#98c379", "yellow": "#e5c07b",
            "blue": "#61afef", "magenta": "#c678dd", "cyan": "#56b6c2", "white": "#abb2bf",
            "brightBlack": "#5c6370", "brightRed": "#e06c75", "brightGreen": "#98c379",
            "brightYellow": "#e5c07b", "brightBlue": "#61afef", "brightMagenta": "#c678dd",
            "brightCyan": "#56b6c2", "brightWhite": "#ffffff"
        })
    }

    fn parse_value(v: &Value) -> Result<(CustomScheme, Vec<String>), ThemeError> {
        parse(v.to_string().as_bytes())
    }

    #[test]
    fn a_valid_file_parses() {
        let (scheme, ignored) = parse_value(&file()).unwrap();
        assert_eq!(scheme.id, "custom-graphite-dark");
        assert_eq!(scheme.name, "Graphite Dark");
        assert_eq!(scheme.mode, SchemeMode::Dark);
        assert_eq!(scheme.colors.cursor, "#5b8cff");
        assert_eq!(scheme.colors.bright_white, "#ffffff");
        assert!(ignored.is_empty());
    }

    #[test]
    fn a_missing_colour_names_its_field() {
        let mut v = file();
        v.as_object_mut().unwrap().remove("brightCyan");
        assert_eq!(parse_value(&v), Err(ThemeError::invalid("brightCyan")));
        let mut v = file();
        v.as_object_mut().unwrap().remove("name");
        assert_eq!(parse_value(&v), Err(ThemeError::invalid("name")));
    }

    #[test]
    fn only_hex_colours_are_accepted() {
        for bad in [
            "red",
            "rgb(1,2,3)",
            "#12345",
            "#12345678",
            "#ggg",
            "",
            "123456",
        ] {
            let mut v = file();
            v["red"] = json!(bad);
            assert_eq!(parse_value(&v), Err(ThemeError::invalid("red")), "{bad}");
        }
        let mut v = file();
        v["red"] = json!(7);
        assert_eq!(parse_value(&v), Err(ThemeError::invalid("red")));
        let mut v = file();
        v["red"] = json!("#ABC");
        assert_eq!(parse_value(&v).unwrap().0.colors.red, "#aabbcc");
    }

    #[test]
    fn a_bad_optional_colour_is_refused_too() {
        let mut v = file();
        v["cursor"] = json!("blue");
        assert_eq!(parse_value(&v), Err(ThemeError::invalid("cursor")));
    }

    #[test]
    fn a_big_file_is_too_large() {
        let big = vec![b' '; THEME_FILE_MAX as usize + 1];
        assert_eq!(
            parse(&big),
            Err(ThemeError {
                code: "theme_too_large",
                field: None
            })
        );
    }

    #[test]
    fn the_name_is_at_most_sixty_characters() {
        let mut v = file();
        v["name"] = json!("a".repeat(THEME_NAME_MAX));
        assert!(parse_value(&v).is_ok());
        v["name"] = json!("a".repeat(THEME_NAME_MAX + 1));
        assert_eq!(parse_value(&v), Err(ThemeError::invalid("name")));
        v["name"] = json!("   ");
        assert_eq!(parse_value(&v), Err(ThemeError::invalid("name")));
    }

    #[test]
    fn the_kind_is_inferred_from_the_background() {
        let mut v = file();
        v.as_object_mut().unwrap().remove("kind");
        assert_eq!(parse_value(&v).unwrap().0.mode, SchemeMode::Dark);
        v["background"] = json!("#fafafa");
        assert_eq!(parse_value(&v).unwrap().0.mode, SchemeMode::Light);
        v["kind"] = json!("dark");
        assert_eq!(parse_value(&v).unwrap().0.mode, SchemeMode::Dark);
        v["kind"] = json!("sepia");
        assert_eq!(parse_value(&v), Err(ThemeError::invalid("kind")));
    }

    #[test]
    fn optional_colours_get_defaults() {
        let mut v = file();
        for k in OPTIONAL {
            v.as_object_mut().unwrap().remove(k);
        }
        let c = parse_value(&v).unwrap().0.colors;
        assert_eq!(c.cursor, c.foreground);
        assert_eq!(c.cursor_accent, c.background);
        assert_eq!(c.selection_background, "#45474c");
    }

    #[test]
    fn unknown_keys_are_listed_not_refused() {
        let mut v = file();
        v["zebra"] = json!(1);
        v["alpha"] = json!("x");
        let (_, ignored) = parse_value(&v).unwrap();
        assert_eq!(ignored, vec!["alpha".to_string(), "zebra".to_string()]);
    }

    #[test]
    fn a_wrong_format_or_version_is_refused() {
        let mut v = file();
        v["format"] = json!("other");
        assert_eq!(parse_value(&v), Err(ThemeError::invalid("format")));
        let mut v = file();
        v["version"] = json!(2);
        assert_eq!(parse_value(&v), Err(ThemeError::invalid("version")));
        assert_eq!(parse(b"not json"), Err(ThemeError::invalid("file")));
        assert_eq!(parse(b"[1]"), Err(ThemeError::invalid("file")));
    }

    #[test]
    fn contrast_ratio_matches_wcag() {
        assert!((contrast_ratio("#000000", "#ffffff") - 21.0).abs() < 1e-9);
        assert!((contrast_ratio("#fff", "#fff") - 1.0).abs() < 1e-9);
        // #777 on white is the textbook 4.48:1.
        assert!((contrast_ratio("#777777", "#ffffff") - 4.48).abs() < 0.01);
        assert_eq!(contrast_ratio("nope", "#ffffff"), 1.0);
        assert!(contrast_ratio("#d7dae0", "#14161a") > MIN_CONTRAST);
    }

    #[test]
    fn slugs_obey_the_id_rule() {
        assert_eq!(slug("Graphite Dark", SLUG_MAX), "graphite-dark");
        assert_eq!(slug("  --A__b!! ", SLUG_MAX), "a-b");
        assert_eq!(slug("đêm", SLUG_MAX), "m");
        assert_eq!(slug("日本", SLUG_MAX), "theme");
        let long = slug(&"ab ".repeat(40), SLUG_MAX);
        assert!(long.chars().count() <= SLUG_MAX && !long.ends_with('-'));
        assert!(format!("custom-{long}").len() <= 40);
    }
}
