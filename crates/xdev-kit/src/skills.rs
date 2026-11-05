use std::cmp::Ordering;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::{Agent, Home, approx_tokens, fnv1a_hex};

const MAX_DEPTH: usize = 3;
const MAX_DESCRIPTION: usize = 300;
const SKILL_FILE: &str = "SKILL.md";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum SkillScope {
    User,
    Project,
    Plugin {
        market: String,
        plugin: String,
        version: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub scope: SkillScope,
    /// `None` for a project skill.
    pub home_id: Option<String>,
    /// The skill's folder; `SKILL.md` is inside it.
    pub dir: PathBuf,
    /// Of `SKILL.md` alone.
    pub bytes: u64,
    pub tokens: u64,
    /// FNV-1a of the file bytes. Tells copies apart; not a security hash.
    pub hash: String,
    /// Another skill has this name and different bytes.
    pub duplicate: bool,
}

/// Every skill the homes and the worktree load, in home order, then plugin
/// skills, then project skills.
pub fn scan_skills(homes: &[Home], worktree: Option<&Path>) -> Vec<Skill> {
    let mut out = Vec::new();
    for home in homes {
        let mut dirs = Vec::new();
        collect_skill_dirs(&home.path.join("skills"), 1, &mut dirs);
        for dir in dirs {
            push_skill(&mut out, dir, SkillScope::User, Some(&home.id));
        }
        if home.agent == Agent::Claude {
            for (dir, scope) in plugin_skill_dirs(&home.path.join("plugins/cache")) {
                push_skill(&mut out, dir, scope, Some(&home.id));
            }
        }
    }
    if let Some(wt) = worktree {
        for dir in sorted_subdirs(&wt.join(".claude/skills")) {
            push_skill(&mut out, dir, SkillScope::Project, None);
        }
    }
    mark_duplicates(&mut out);
    out
}

/// Skills directly under `root` (same depth and dot-folder rules as a home's
/// `skills` folder), scope `User`, `home_id` as given. Duplicates are not
/// marked; the caller marks them with [`mark_duplicates`].
pub fn scan_skill_root(root: &Path, home_id: &str) -> Vec<Skill> {
    let mut dirs = Vec::new();
    collect_skill_dirs(root, 1, &mut dirs);
    let mut out = Vec::new();
    for dir in dirs {
        push_skill(&mut out, dir, SkillScope::User, Some(home_id));
    }
    out
}

/// Folders holding a `SKILL.md`, at most `MAX_DEPTH` levels below `skills`.
fn collect_skill_dirs(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    // Dot folders hold trash, version control or tool state, not skills.
    for sub in sorted_subdirs(dir) {
        if file_name(&sub).starts_with('.') {
            continue;
        }
        if sub.join(SKILL_FILE).is_file() {
            out.push(sub.clone());
        }
        if depth < MAX_DEPTH {
            collect_skill_dirs(&sub, depth + 1, out);
        }
    }
}

/// `<market>/<plugin>/<version>/skills/*`, for the highest version of each plugin.
fn plugin_skill_dirs(cache: &Path) -> Vec<(PathBuf, SkillScope)> {
    let mut out = Vec::new();
    for market in sorted_subdirs(cache) {
        for plugin in sorted_subdirs(&market) {
            let best = sorted_subdirs(&plugin)
                .into_iter()
                .max_by(|a, b| compare_versions(&file_name(a), &file_name(b)));
            let Some(version) = best else { continue };
            let scope = SkillScope::Plugin {
                market: file_name(&market),
                plugin: file_name(&plugin),
                version: file_name(&version),
            };
            for dir in sorted_subdirs(&version.join("skills")) {
                if dir.join(SKILL_FILE).is_file() {
                    out.push((dir, scope.clone()));
                }
            }
        }
    }
    out
}

#[derive(PartialEq, Eq, PartialOrd, Ord)]
enum Part {
    Num(u64),
    Text(String),
}

/// Dot parts compared as numbers; a part that is not a number is compared as
/// text, and sorts after any number.
fn compare_versions(a: &str, b: &str) -> Ordering {
    let parts = |v: &str| -> Vec<Part> {
        v.split('.')
            .map(|p| {
                p.parse()
                    .map_or_else(|_| Part::Text(p.to_owned()), Part::Num)
            })
            .collect()
    };
    parts(a).cmp(&parts(b))
}

fn push_skill(out: &mut Vec<Skill>, dir: PathBuf, scope: SkillScope, home_id: Option<&str>) {
    let Ok(raw) = fs::read(dir.join(SKILL_FILE)) else {
        return;
    };
    let text = String::from_utf8_lossy(&raw);
    let (name, description) = front_matter(&text);
    let bytes = raw.len() as u64;
    out.push(Skill {
        name: name.unwrap_or_else(|| file_name(&dir)),
        description: description.unwrap_or_default(),
        scope,
        home_id: home_id.map(str::to_owned),
        dir,
        bytes,
        tokens: approx_tokens(bytes),
        hash: fnv1a_hex(&raw),
        duplicate: false,
    });
}

/// `name` and `description` from the block between the first two `---` lines.
/// Only one-line `key: value` pairs are read. The block must open the file.
fn front_matter(text: &str) -> (Option<String>, Option<String>) {
    let mut lines = text.trim_start_matches('\u{feff}').lines();
    if lines.by_ref().find(|l| !l.trim().is_empty()).map(str::trim) != Some("---") {
        return (None, None);
    }
    let (mut name, mut description) = (None, None);
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim().trim_matches(['"', '\'']).trim();
        if value.is_empty() {
            continue;
        }
        match key.trim() {
            "name" => name = Some(value.to_owned()),
            "description" => description = Some(value.chars().take(MAX_DESCRIPTION).collect()),
            _ => {}
        }
    }
    (name, description)
}

/// Sets `duplicate` on every skill whose name is shared with a skill of
/// different bytes.
pub fn mark_duplicates(skills: &mut [Skill]) {
    let mut hashes: HashMap<String, Vec<String>> = HashMap::new();
    for s in skills.iter() {
        let seen = hashes.entry(s.name.clone()).or_default();
        if !seen.contains(&s.hash) {
            seen.push(s.hash.clone());
        }
    }
    for s in skills.iter_mut() {
        s.duplicate = hashes[&s.name].len() > 1;
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Sub-folders by name; a missing or unreadable folder gives none. A link to
/// a folder counts as a folder.
fn sorted_subdirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    dirs
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Agent, HomeSource};
    use std::fs;
    use std::path::Path;

    fn home(id: &str, agent: Agent, path: &Path) -> Home {
        Home {
            id: id.into(),
            agent,
            path: path.to_path_buf(),
            source: HomeSource::Own,
        }
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn reads_front_matter_name_and_description() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join("skills/folder-x/SKILL.md"),
            "---\nname: pretty-name\ndescription: \"Does a thing\"\nother: 1\n---\n\n# Body\n",
        );
        let skills = scan_skills(&[home("own-claude", Agent::Claude, dir.path())], None);
        assert_eq!(skills.len(), 1);
        let s = &skills[0];
        assert_eq!(s.name, "pretty-name");
        assert_eq!(s.description, "Does a thing");
        assert_eq!(s.scope, SkillScope::User);
        assert_eq!(s.home_id.as_deref(), Some("own-claude"));
        assert_eq!(s.dir, dir.path().join("skills/folder-x"));
        assert_eq!(s.bytes, 71);
        assert_eq!(s.tokens, 18);
        assert_eq!(s.hash.len(), 16);
        assert!(!s.duplicate);
    }

    #[test]
    fn description_is_cut_to_300_chars() {
        let dir = tempfile::tempdir().unwrap();
        let long = "é".repeat(400);
        write(
            &dir.path().join("skills/a/SKILL.md"),
            &format!("---\ndescription: {long}\n---\n"),
        );
        let skills = scan_skills(&[home("h", Agent::Codex, dir.path())], None);
        assert_eq!(skills[0].description.chars().count(), 300);
    }

    #[test]
    fn folder_name_when_no_front_matter() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join("skills/plain/SKILL.md"),
            "# Just text\n\nname: not-front-matter\n",
        );
        // Nested, three levels below `skills`.
        write(
            &dir.path().join("skills/a/b/deep/SKILL.md"),
            "---\nname:\n---\n",
        );
        // Four levels below `skills`: not read.
        write(&dir.path().join("skills/a/b/c/d/SKILL.md"), "x");
        let skills = scan_skills(&[home("h", Agent::Codex, dir.path())], None);
        let mut names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, ["deep", "plain"]);
        assert_eq!(
            skills
                .iter()
                .find(|s| s.name == "plain")
                .unwrap()
                .description,
            ""
        );
    }

    #[test]
    fn plugin_uses_highest_version_only() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("plugins/cache/market/plug");
        for v in ["1.9.0", "1.10.0"] {
            write(
                &base.join(v).join("skills/s/SKILL.md"),
                &format!("---\nname: s-{v}\n---\n"),
            );
        }
        let skills = scan_skills(&[home("own-claude", Agent::Claude, dir.path())], None);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "s-1.10.0");
        assert_eq!(
            skills[0].scope,
            SkillScope::Plugin {
                market: "market".into(),
                plugin: "plug".into(),
                version: "1.10.0".into()
            }
        );
        // Codex homes have no plugin cache.
        let codex = scan_skills(&[home("own-codex", Agent::Codex, dir.path())], None);
        assert!(codex.is_empty());
    }

    #[test]
    fn project_skills_have_no_home() {
        let wt = tempfile::tempdir().unwrap();
        write(
            &wt.path().join(".claude/skills/proj/SKILL.md"),
            "---\nname: proj\n---\n",
        );
        let skills = scan_skills(&[], Some(wt.path()));
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].scope, SkillScope::Project);
        assert_eq!(skills[0].home_id, None);
    }

    #[test]
    fn same_name_different_bytes_is_duplicate() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        write(
            &a.path().join("skills/x/SKILL.md"),
            "---\nname: x\n---\none\n",
        );
        write(
            &b.path().join("skills/x/SKILL.md"),
            "---\nname: x\n---\ntwo\n",
        );
        write(
            &a.path().join("skills/same/SKILL.md"),
            "---\nname: same\n---\nsame\n",
        );
        write(
            &b.path().join("skills/same/SKILL.md"),
            "---\nname: same\n---\nsame\n",
        );
        let homes = [
            home("acct-a", Agent::Claude, a.path()),
            home("acct-b", Agent::Claude, b.path()),
        ];
        let skills = scan_skills(&homes, None);
        assert_eq!(skills.len(), 4);
        for s in &skills {
            assert_eq!(s.duplicate, s.name == "x", "{}", s.name);
        }
    }

    #[test]
    fn dot_folders_are_not_walked() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join("skills/live/SKILL.md"),
            "---
name: live
---
new
",
        );
        write(
            &dir.path().join("skills/.trash/live/SKILL.md"),
            "---
name: live
---
old
",
        );
        write(&dir.path().join("skills/.hidden/SKILL.md"), "x");
        write(&dir.path().join("skills/a/.git/x/SKILL.md"), "x");
        let skills = scan_skills(&[home("h", Agent::Claude, dir.path())], None);
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["live"]);
        assert!(!skills[0].duplicate);
    }

    #[test]
    fn scan_skill_root_finds_skills_and_skips_dot_folders() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("shared");
        write(&root.join("a/SKILL.md"), "---\nname: alpha\n---\n");
        write(&root.join("group/b/SKILL.md"), "plain");
        write(&root.join(".trash/c/SKILL.md"), "x");
        write(&root.join(".hidden/SKILL.md"), "x");
        let skills = scan_skill_root(&root, "agents");
        let mut names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, ["alpha", "b"]);
        assert!(skills.iter().all(|s| s.scope == SkillScope::User));
        assert!(
            skills
                .iter()
                .all(|s| s.home_id.as_deref() == Some("agents"))
        );
        assert!(scan_skill_root(&dir.path().join("none"), "agents").is_empty());
    }

    #[test]
    fn mark_duplicates_is_public_and_stable() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join("one/x/SKILL.md"),
            "---\nname: same\n---\none",
        );
        write(
            &dir.path().join("two/x/SKILL.md"),
            "---\nname: same\n---\ntwo",
        );
        write(&dir.path().join("two/y/SKILL.md"), "---\nname: solo\n---\n");
        let mut all = scan_skill_root(&dir.path().join("one"), "a");
        all.extend(scan_skill_root(&dir.path().join("two"), "b"));
        assert!(all.iter().all(|s| !s.duplicate));
        mark_duplicates(&mut all);
        let flags: Vec<(&str, bool)> = all.iter().map(|s| (s.name.as_str(), s.duplicate)).collect();
        assert_eq!(flags, [("same", true), ("same", true), ("solo", false)]);
        let before = all.clone();
        mark_duplicates(&mut all);
        assert_eq!(all, before);
    }
}
