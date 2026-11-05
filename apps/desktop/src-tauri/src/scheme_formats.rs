//! Readers for colour-scheme files other terminals write: Warp theme YAML and iTerm
//! `.itermcolors`. Each turns the file into this app's own theme document (a JSON value in the
//! `xdev-terminal-theme` format) so `terminal_themes::parse` checks it like any other file.
//! Pure: bytes in, value out; no new dependency.

use serde_json::{Map, Value, json};

const NAMES: [&str; 8] = [
    "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
];
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

/// Which format the bytes look like, by their first non-blank content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Json,
    ItermColors,
    WarpYaml,
}

pub fn sniff(text: &str) -> Format {
    let t = text.trim_start_matches('\u{feff}').trim_start();
    if t.starts_with('{') {
        Format::Json
    } else if t.starts_with("<?xml") || t.starts_with("<plist") || t.starts_with("<!DOCTYPE") {
        Format::ItermColors
    } else {
        Format::WarpYaml
    }
}

fn doc(name: &str, fields: Map<String, Value>) -> Value {
    let mut o = Map::new();
    o.insert("format".into(), json!("xdev-terminal-theme"));
    o.insert("version".into(), json!(1));
    o.insert("name".into(), json!(name));
    o.extend(fields);
    Value::Object(o)
}

// ---- Warp YAML ----

fn unquote(v: &str) -> String {
    let v = v.trim();
    let quoted = v.starts_with('\'') || v.starts_with('"');
    // A trailing comment after an unquoted value.
    let v = if quoted {
        v
    } else {
        v.split(" #").next().unwrap_or(v).trim()
    };
    if quoted && v.len() >= 2 {
        let q = &v[..1];
        if let Some(end) = v[1..].find(q) {
            return v[1..1 + end].to_string();
        }
    }
    v.to_string()
}

/// `a.b.c` paths of a YAML subset: nested maps of scalars at any consistent indent.
fn yaml_paths(text: &str) -> Vec<(String, String)> {
    let mut stack: Vec<(usize, String)> = Vec::new();
    let mut out = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed == "---" {
            continue;
        }
        let indent = line.len() - trimmed.len();
        let Some((key, value)) = trimmed.split_once(':') else {
            continue;
        };
        while stack.last().is_some_and(|(i, _)| *i >= indent) {
            stack.pop();
        }
        let key = unquote(key);
        let value = value.trim();
        if value.is_empty() || value.starts_with('#') {
            stack.push((indent, key));
        } else {
            let mut path: Vec<&str> = stack.iter().map(|(_, k)| k.as_str()).collect();
            path.push(&key);
            out.push((path.join("."), unquote(value)));
        }
    }
    out
}

/// A Warp theme file as the app's theme document. `fallback_name` names it when the file has no
/// `name`.
pub fn warp_to_doc(text: &str, fallback_name: &str) -> Result<Value, String> {
    let paths = yaml_paths(text);
    let get = |p: &str| paths.iter().find(|(k, _)| k == p).map(|(_, v)| v.clone());
    if get("background").is_none() && get("terminal_colors.normal.black").is_none() {
        return Err("file".into());
    }
    let mut f = Map::new();
    if let Some(v) = get("foreground") {
        f.insert("foreground".into(), json!(v));
    }
    if let Some(v) = get("background") {
        f.insert("background".into(), json!(v));
    }
    if let Some(v) = get("cursor").or_else(|| get("accent")) {
        f.insert("cursor".into(), json!(v));
    }
    for (i, key) in KEYS.iter().enumerate() {
        let group = if i < 8 { "normal" } else { "bright" };
        if let Some(v) = get(&format!("terminal_colors.{group}.{}", NAMES[i % 8])) {
            f.insert((*key).into(), json!(v));
        }
    }
    match get("details").as_deref() {
        Some("lighter") => {
            f.insert("kind".into(), json!("light"));
        }
        Some("darker") => {
            f.insert("kind".into(), json!("dark"));
        }
        _ => {}
    }
    let name = get("name").unwrap_or_else(|| fallback_name.to_string());
    Ok(doc(&name, f))
}

// ---- iTerm .itermcolors ----

fn tag_text<'a>(s: &'a str, tag: &str) -> Option<(&'a str, &'a str)> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let a = s.find(&open)?;
    let b = s[a..].find(&close)? + a;
    Some((&s[a + open.len()..b], &s[b + close.len()..]))
}

/// The `<key>name</key><dict>…</dict>` colour as `#rrggbb`.
fn iterm_colour(text: &str, key: &str) -> Option<String> {
    let marker = format!("<key>{key}</key>");
    let at = text.find(&marker)? + marker.len();
    let rest = &text[at..];
    let d0 = rest.find("<dict>")? + "<dict>".len();
    let d1 = rest.find("</dict>")?;
    let mut body = rest.get(d0..d1)?;
    let (mut r, mut g, mut b) = (None, None, None);
    while let Some((k, after)) = tag_text(body, "key") {
        // Only a number right after its key counts; other value types are skipped.
        let lead = after.trim_start();
        let number = if lead.starts_with("<real>") {
            tag_text(lead, "real")
        } else if lead.starts_with("<integer>") {
            tag_text(lead, "integer")
        } else {
            None
        };
        let Some((val, next)) = number else {
            body = after;
            continue;
        };
        let v: f64 = val.trim().parse().ok()?;
        match k {
            "Red Component" => r = Some(v),
            "Green Component" => g = Some(v),
            "Blue Component" => b = Some(v),
            _ => {}
        }
        body = next;
    }
    let ch = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    Some(format!("#{:02x}{:02x}{:02x}", ch(r?), ch(g?), ch(b?)))
}

/// An `.itermcolors` plist as the app's theme document, named `fallback_name`.
pub fn iterm_to_doc(text: &str, fallback_name: &str) -> Result<Value, String> {
    if !text.contains("<plist") {
        return Err("file".into());
    }
    let mut f = Map::new();
    for (i, key) in KEYS.iter().enumerate() {
        if let Some(c) = iterm_colour(text, &format!("Ansi {i} Color")) {
            f.insert((*key).into(), json!(c));
        }
    }
    for (src, dst) in [
        ("Background Color", "background"),
        ("Foreground Color", "foreground"),
        ("Cursor Color", "cursor"),
        ("Cursor Text Color", "cursorAccent"),
        ("Selection Color", "selectionBackground"),
    ] {
        if let Some(c) = iterm_colour(text, src) {
            f.insert(dst.into(), json!(c));
        }
    }
    Ok(doc(fallback_name, f))
}

#[cfg(test)]
mod tests {
    use super::*;

    const WARP: &str = "# a theme\naccent: '#268bd2'\nbackground: '#002b36'\nforeground: \"#839496\"\ndetails: darker\nterminal_colors:\n  normal:\n    black: '#073642'\n    red: '#dc322f'\n    green: '#859900'\n    yellow: '#b58900'\n    blue: '#268bd2'\n    magenta: '#d33682'\n    cyan: '#2aa198'\n    white: '#eee8d5'\n  bright:\n    black: '#002b36'\n    red: '#cb4b16'\n    green: '#586e75'\n    yellow: '#657b83'\n    blue: '#839496'\n    magenta: '#6c71c4'\n    cyan: '#93a1a1'\n    white: '#fdf6e3'\n";

    fn iterm_entry(name: &str, r: f64, g: f64, b: f64) -> String {
        format!(
            "<key>{name}</key><dict><key>Alpha Component</key><real>1</real><key>Blue Component</key><real>{b}</real><key>Color Space</key><string>sRGB</string><key>Green Component</key><real>{g}</real><key>Red Component</key><real>{r}</real></dict>"
        )
    }

    fn iterm() -> String {
        let mut s = String::from("<?xml version=\"1.0\"?><plist version=\"1.0\"><dict>");
        for i in 0..16 {
            s += &iterm_entry(&format!("Ansi {i} Color"), i as f64 / 15.0, 0.0, 1.0);
        }
        s += &iterm_entry("Background Color", 0.0, 0.0, 0.0);
        s += &iterm_entry("Foreground Color", 1.0, 1.0, 1.0);
        s += &iterm_entry("Cursor Color", 1.0, 0.5, 0.0);
        s += &iterm_entry("Selection Color", 0.2, 0.2, 0.2);
        s + "</dict></plist>"
    }

    #[test]
    fn sniffs_the_format() {
        assert_eq!(sniff("  {\"a\":1}"), Format::Json);
        assert_eq!(sniff("<?xml version"), Format::ItermColors);
        assert_eq!(sniff("background: '#000'"), Format::WarpYaml);
    }

    #[test]
    fn warp_reads_colours_and_kind() {
        let v = warp_to_doc(WARP, "Solar").unwrap();
        assert_eq!(v["name"], "Solar");
        assert_eq!(v["background"], "#002b36");
        assert_eq!(v["foreground"], "#839496");
        assert_eq!(v["cursor"], "#268bd2");
        assert_eq!(v["red"], "#dc322f");
        assert_eq!(v["brightWhite"], "#fdf6e3");
        assert_eq!(v["kind"], "dark");
    }

    #[test]
    fn warp_without_colours_is_refused() {
        assert!(warp_to_doc("hello: world\n", "x").is_err());
    }

    #[test]
    fn iterm_reads_float_components() {
        let v = iterm_to_doc(&iterm(), "Night").unwrap();
        assert_eq!(v["name"], "Night");
        assert_eq!(v["black"], "#0000ff");
        assert_eq!(v["brightWhite"], "#ff00ff");
        assert_eq!(v["background"], "#000000");
        assert_eq!(v["foreground"], "#ffffff");
        assert_eq!(v["cursor"], "#ff8000");
        assert_eq!(v["selectionBackground"], "#333333");
    }

    #[test]
    fn iterm_needs_a_plist() {
        assert!(iterm_to_doc("nope", "x").is_err());
    }
}
