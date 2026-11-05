//! Composer drafts: the unsent text of each terminal tab's prompt box, kept
//! across tab switches and app restarts. One file, `<data_dir>/kit/drafts.json`,
//! keyed by tab id. A draft holds at most `DRAFT_MAX_BYTES`; when more than
//! `DRAFTS_MAX` tabs have one, the oldest drafts are dropped.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::KitError;

const VERSION: u32 = 1;

/// The most bytes (UTF-8) one draft holds.
pub const DRAFT_MAX_BYTES: usize = 64 * 1024;
/// The most drafts kept; the oldest go first.
pub const DRAFTS_MAX: usize = 500;
/// The longest tab id a draft is kept under.
pub const TAB_ID_MAX: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Draft {
    text: String,
    /// Unix ms of the last put.
    at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Drafts {
    version: u32,
    #[serde(default)]
    drafts: BTreeMap<String, Draft>,
}

impl Default for Drafts {
    fn default() -> Self {
        Self {
            version: VERSION,
            drafts: BTreeMap::new(),
        }
    }
}

fn drafts_path(data_dir: &Path) -> PathBuf {
    data_dir.join("kit").join("drafts.json")
}

fn check_tab(tab_id: &str) -> Result<(), KitError> {
    if tab_id.is_empty() || tab_id.len() > TAB_ID_MAX || tab_id.chars().any(char::is_control) {
        return Err(KitError::Parse("bad tab id".into()));
    }
    Ok(())
}

impl Drafts {
    /// Missing, unreadable or of another version gives no drafts.
    pub fn load(data_dir: &Path) -> Self {
        fs::read(drafts_path(data_dir))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Drafts>(&bytes).ok())
            .filter(|d| d.version == VERSION)
            .unwrap_or_default()
    }

    /// Atomic: written aside, then renamed over.
    pub fn save(&self, data_dir: &Path) -> Result<(), KitError> {
        let path = drafts_path(data_dir);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let bytes = serde_json::to_vec(self).map_err(|e| KitError::Parse(e.to_string()))?;
        let tmp = path.with_extension("json.xdev-tmp");
        fs::write(&tmp, bytes)?;
        fs::rename(&tmp, &path)?;
        Ok(())
    }

    /// The draft of `tab_id`; `None` when it has none.
    pub fn get(&self, tab_id: &str) -> Option<&str> {
        self.drafts.get(tab_id).map(|d| d.text.as_str())
    }

    /// Keeps `text` as the draft of `tab_id`; an empty text clears it.
    /// Refuses a text over `DRAFT_MAX_BYTES` ("draft too large") and a bad id.
    pub fn put(&mut self, tab_id: &str, text: &str, at: i64) -> Result<(), KitError> {
        check_tab(tab_id)?;
        if text.len() > DRAFT_MAX_BYTES {
            return Err(KitError::Parse("draft too large".into()));
        }
        if text.is_empty() {
            self.drafts.remove(tab_id);
            return Ok(());
        }
        self.drafts.insert(
            tab_id.to_owned(),
            Draft {
                text: text.to_owned(),
                at,
            },
        );
        while self.drafts.len() > DRAFTS_MAX {
            let oldest = self
                .drafts
                .iter()
                .filter(|(k, _)| k.as_str() != tab_id)
                .min_by_key(|(_, d)| d.at)
                .map(|(k, _)| k.clone());
            match oldest {
                Some(k) => self.drafts.remove(&k),
                None => break,
            };
        }
        Ok(())
    }

    /// Forgets the draft of `tab_id`; true when there was one.
    pub fn clear(&mut self, tab_id: &str) -> bool {
        self.drafts.remove(tab_id).is_some()
    }

    pub fn len(&self) -> usize {
        self.drafts.len()
    }

    pub fn is_empty(&self) -> bool {
        self.drafts.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn put_get_clear_roundtrip() {
        let mut d = Drafts::default();
        assert_eq!(d.get("t1"), None);
        d.put("t1", "hello\nworld", 1).unwrap();
        assert_eq!(d.get("t1"), Some("hello\nworld"));
        assert!(d.clear("t1"));
        assert!(!d.clear("t1"));
        assert_eq!(d.get("t1"), None);
    }

    #[test]
    fn an_empty_put_clears() {
        let mut d = Drafts::default();
        d.put("t1", "x", 1).unwrap();
        d.put("t1", "", 2).unwrap();
        assert!(d.is_empty());
    }

    #[test]
    fn a_draft_over_64_kb_is_refused_and_one_at_the_bound_is_kept() {
        let mut d = Drafts::default();
        let at_bound = "a".repeat(DRAFT_MAX_BYTES);
        d.put("t1", &at_bound, 1).unwrap();
        let over = "a".repeat(DRAFT_MAX_BYTES + 1);
        let err = d.put("t1", &over, 2).unwrap_err();
        assert!(matches!(err, KitError::Parse(ref m) if m == "draft too large"));
        assert_eq!(d.get("t1").map(str::len), Some(DRAFT_MAX_BYTES));
    }

    #[test]
    fn bad_tab_ids_are_refused() {
        let mut d = Drafts::default();
        assert!(d.put("", "x", 1).is_err());
        assert!(d.put(&"a".repeat(TAB_ID_MAX + 1), "x", 1).is_err());
        assert!(d.put("a\nb", "x", 1).is_err());
    }

    #[test]
    fn the_oldest_draft_goes_when_over_the_count() {
        let mut d = Drafts::default();
        for i in 0..DRAFTS_MAX {
            d.put(&format!("t{i}"), "x", 100 + i as i64).unwrap();
        }
        d.put("new", "y", 1).unwrap();
        assert_eq!(d.len(), DRAFTS_MAX);
        assert_eq!(d.get("t0"), None);
        assert_eq!(d.get("new"), Some("y"));
    }

    #[test]
    fn save_and_load_roundtrip_and_bad_file_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let mut d = Drafts::default();
        d.put("t1", "draft", 5).unwrap();
        d.save(tmp.path()).unwrap();
        assert_eq!(Drafts::load(tmp.path()), d);
        fs::write(drafts_path(tmp.path()), "not json").unwrap();
        assert!(Drafts::load(tmp.path()).is_empty());
        fs::write(drafts_path(tmp.path()), r#"{"version":99,"drafts":{}}"#).unwrap();
        assert!(Drafts::load(tmp.path()).is_empty());
    }
}
