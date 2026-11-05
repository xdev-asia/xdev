//! Prompt templates: named prompt texts the composer inserts at the cursor or
//! appends on send. One file, `<data_dir>/kit/templates.json`. At most
//! `TEMPLATES_MAX` templates; each body holds at most `TEMPLATE_BODY_MAX_BYTES`.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::KitError;

const VERSION: u32 = 1;

/// The most templates kept.
pub const TEMPLATES_MAX: usize = 200;
/// The most bytes (UTF-8) of one template's body.
pub const TEMPLATE_BODY_MAX_BYTES: usize = 64 * 1024;
/// The most characters of one template's name.
pub const TEMPLATE_NAME_MAX_CHARS: usize = 80;
/// The longest template id.
pub const TEMPLATE_ID_MAX: usize = 64;

/// Where a template's text goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum TemplateMode {
    /// Inserted at the cursor when picked.
    Insert,
    /// Added after the prompt when it is sent.
    Append,
}

/// One named prompt template.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PromptTemplate {
    /// Chosen by the UI: ASCII letters, digits, `-` and `_`.
    pub id: String,
    pub name: String,
    pub body: String,
    pub mode: TemplateMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Templates {
    version: u32,
    #[serde(default)]
    templates: Vec<PromptTemplate>,
}

impl Default for Templates {
    fn default() -> Self {
        Self {
            version: VERSION,
            templates: Vec::new(),
        }
    }
}

fn templates_path(data_dir: &Path) -> PathBuf {
    data_dir.join("kit").join("templates.json")
}

fn check(t: &PromptTemplate) -> Result<(), KitError> {
    let id_ok = !t.id.is_empty()
        && t.id.len() <= TEMPLATE_ID_MAX
        && t.id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !id_ok {
        return Err(KitError::Parse("bad template id".into()));
    }
    let name = t.name.trim();
    if name.is_empty()
        || name.chars().count() > TEMPLATE_NAME_MAX_CHARS
        || name.chars().any(char::is_control)
    {
        return Err(KitError::Parse("bad template name".into()));
    }
    if t.body.len() > TEMPLATE_BODY_MAX_BYTES {
        return Err(KitError::Parse("template too large".into()));
    }
    Ok(())
}

impl Templates {
    /// Missing, unreadable or of another version gives no templates.
    pub fn load(data_dir: &Path) -> Self {
        fs::read(templates_path(data_dir))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Templates>(&bytes).ok())
            .filter(|t| t.version == VERSION)
            .unwrap_or_default()
    }

    /// Atomic: written aside, then renamed over.
    pub fn save(&self, data_dir: &Path) -> Result<(), KitError> {
        let path = templates_path(data_dir);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let bytes = serde_json::to_vec(self).map_err(|e| KitError::Parse(e.to_string()))?;
        let tmp = path.with_extension("json.xdev-tmp");
        fs::write(&tmp, bytes)?;
        fs::rename(&tmp, &path)?;
        Ok(())
    }

    /// Every template, by name (case-insensitive), then id.
    pub fn list(&self) -> Vec<PromptTemplate> {
        let mut all = self.templates.clone();
        all.sort_by(|a, b| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then_with(|| a.id.cmp(&b.id))
        });
        all
    }

    /// Adds `t`, or replaces the one with its id. The name is trimmed.
    /// Refuses a bad id, name or body, and a new template past `TEMPLATES_MAX`
    /// ("too many templates").
    pub fn put(&mut self, mut t: PromptTemplate) -> Result<(), KitError> {
        check(&t)?;
        t.name = t.name.trim().to_owned();
        if let Some(slot) = self.templates.iter_mut().find(|x| x.id == t.id) {
            *slot = t;
            return Ok(());
        }
        if self.templates.len() >= TEMPLATES_MAX {
            return Err(KitError::Parse("too many templates".into()));
        }
        self.templates.push(t);
        Ok(())
    }

    /// Removes the template `id`; true when it was there.
    pub fn delete(&mut self, id: &str) -> bool {
        let before = self.templates.len();
        self.templates.retain(|t| t.id != id);
        self.templates.len() != before
    }

    pub fn len(&self) -> usize {
        self.templates.len()
    }

    pub fn is_empty(&self) -> bool {
        self.templates.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tpl(id: &str, name: &str, mode: TemplateMode) -> PromptTemplate {
        PromptTemplate {
            id: id.into(),
            name: name.into(),
            body: format!("body of {name}"),
            mode,
        }
    }

    #[test]
    fn put_adds_then_replaces_by_id() {
        let mut t = Templates::default();
        t.put(tpl("a", "  Review  ", TemplateMode::Insert)).unwrap();
        assert_eq!(t.list()[0].name, "Review");
        t.put(tpl("a", "Review 2", TemplateMode::Append)).unwrap();
        assert_eq!(t.len(), 1);
        assert_eq!(t.list()[0].mode, TemplateMode::Append);
    }

    #[test]
    fn list_is_by_name_case_insensitive() {
        let mut t = Templates::default();
        t.put(tpl("1", "beta", TemplateMode::Insert)).unwrap();
        t.put(tpl("2", "Alpha", TemplateMode::Insert)).unwrap();
        let names: Vec<String> = t.list().into_iter().map(|x| x.name).collect();
        assert_eq!(names, ["Alpha", "beta"]);
    }

    #[test]
    fn delete_reports_whether_it_was_there() {
        let mut t = Templates::default();
        t.put(tpl("a", "A", TemplateMode::Insert)).unwrap();
        assert!(t.delete("a"));
        assert!(!t.delete("a"));
        assert!(t.is_empty());
    }

    #[test]
    fn at_most_200_templates_but_a_replace_at_the_bound_works() {
        let mut t = Templates::default();
        for i in 0..TEMPLATES_MAX {
            t.put(tpl(&format!("t{i}"), "n", TemplateMode::Insert))
                .unwrap();
        }
        let err = t
            .put(tpl("one-more", "n", TemplateMode::Insert))
            .unwrap_err();
        assert!(matches!(err, KitError::Parse(ref m) if m == "too many templates"));
        t.put(tpl("t0", "renamed", TemplateMode::Append)).unwrap();
        assert_eq!(t.len(), TEMPLATES_MAX);
    }

    #[test]
    fn bad_ids_names_and_bodies_are_refused() {
        let mut t = Templates::default();
        assert!(t.put(tpl("", "n", TemplateMode::Insert)).is_err());
        assert!(t.put(tpl("a b", "n", TemplateMode::Insert)).is_err());
        assert!(t.put(tpl("../x", "n", TemplateMode::Insert)).is_err());
        assert!(t.put(tpl("a", "   ", TemplateMode::Insert)).is_err());
        let long = "x".repeat(TEMPLATE_NAME_MAX_CHARS + 1);
        assert!(t.put(tpl("a", &long, TemplateMode::Insert)).is_err());
        let mut big = tpl("a", "n", TemplateMode::Insert);
        big.body = "x".repeat(TEMPLATE_BODY_MAX_BYTES + 1);
        assert!(t.put(big).is_err());
        assert!(t.is_empty());
    }

    #[test]
    fn mode_serializes_kebab_case() {
        let json = serde_json::to_string(&tpl("a", "n", TemplateMode::Append)).unwrap();
        assert!(json.contains(r#""mode":"append""#));
    }

    #[test]
    fn save_and_load_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let mut t = Templates::default();
        t.put(tpl("a", "A", TemplateMode::Insert)).unwrap();
        t.save(tmp.path()).unwrap();
        assert_eq!(Templates::load(tmp.path()), t);
        fs::write(templates_path(tmp.path()), "{").unwrap();
        assert!(Templates::load(tmp.path()).is_empty());
    }
}
