use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::{Agent, Home, approx_tokens, fnv1a_hex};

/// An import loads at most this many levels below the file that holds it.
const MAX_IMPORT_DEPTH: usize = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum MemoryKind {
    Instructions,
    Import,
    AutoMemory,
    AutoIndex,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum IssueKind {
    MissingIndexTarget,
    MissingPath,
    ImportCycle,
    ImportOutside,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct MemoryIssue {
    /// 1-based.
    pub line: u32,
    pub kind: IssueKind,
    pub target: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct MemoryFile {
    pub path: PathBuf,
    /// `None` for a file in the worktree, or an import outside every home.
    pub home_id: Option<String>,
    pub kind: MemoryKind,
    /// The file that imports this one.
    pub parent: Option<PathBuf>,
    pub bytes: u64,
    pub tokens: u64,
    /// FNV-1a of the file bytes; empty for an import that was not read.
    pub hash: String,
    pub issues: Vec<MemoryIssue>,
    /// Other homes holding a file with the same relative path and kind but other bytes.
    pub differs_in: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct MemorySet {
    pub files: Vec<MemoryFile>,
    /// Tokens a Claude session in the worktree loads at start, for the first Claude home.
    pub load_tokens: u64,
}

/// The folder name Claude keeps a project's memory under: every char that is
/// not ASCII alphanumeric becomes `-`.
/// [Unverified rule: matches the folder names seen on one Windows machine,
/// e.g. `E:\Codes\xDev` is `E--Codes-xDev`; non-ASCII names are not checked.]
pub fn project_slug(path: &Path) -> String {
    plain(path)
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

pub fn scan_memory(homes: &[Home], worktree: Option<&Path>) -> MemorySet {
    let user_home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from);
    scan_memory_with(homes, worktree, user_home.as_deref())
}

/// `scan_memory` with the folder `~` stands for passed in.
fn scan_memory_with(
    homes: &[Home],
    worktree: Option<&Path>,
    user_home: Option<&Path>,
) -> MemorySet {
    let worktree = worktree.and_then(|w| w.canonicalize().ok());
    let roots: Vec<PathBuf> = homes
        .iter()
        .map(|h| plain(&h.path))
        .chain(worktree.iter().map(|w| plain(w)))
        .collect();
    let mut scan = Scan {
        homes,
        roots,
        user_home,
        files: Vec::new(),
    };
    // Paths a Claude session in the worktree loads at start.
    let mut session: Vec<PathBuf> = Vec::new();
    let mut first_claude = true;

    for home in homes {
        match home.agent {
            Agent::Claude => {
                let counts = std::mem::take(&mut first_claude);
                let mut loaded = Vec::new();
                scan.instructions(&home.path.join("CLAUDE.md"), &mut loaded);
                if counts {
                    session.append(&mut loaded);
                }
                if let Some(wt) = &worktree {
                    let dir = home
                        .path
                        .join("projects")
                        .join(project_slug(wt))
                        .join("memory");
                    for path in sorted_md_files(&dir) {
                        let is_index = path.file_name().is_some_and(|n| n == "MEMORY.md");
                        let kind = if is_index {
                            MemoryKind::AutoIndex
                        } else {
                            MemoryKind::AutoMemory
                        };
                        scan.auto_memory(&path, kind, &dir);
                        if is_index && counts {
                            session.push(path);
                        }
                    }
                }
            }
            Agent::Codex => {
                scan.instructions(&home.path.join("AGENTS.md"), &mut Vec::new());
            }
        }
    }
    if let Some(wt) = &worktree {
        scan.instructions(&wt.join("CLAUDE.md"), &mut session);
        scan.instructions(&wt.join("AGENTS.md"), &mut Vec::new());
        scan.instructions(&wt.join(".claude").join("CLAUDE.md"), &mut session);
    }

    let Scan { mut files, .. } = scan;
    mark_differences(&mut files, homes);
    let counted: HashSet<&PathBuf> = session.iter().collect();
    let load_tokens = files
        .iter()
        .filter(|f| counted.contains(&f.path))
        .map(|f| f.tokens)
        .sum();
    MemorySet { files, load_tokens }
}

struct Scan<'a> {
    homes: &'a [Home],
    /// Canonical, without the `\\?\` prefix: the folders a read may reach.
    roots: Vec<PathBuf>,
    user_home: Option<&'a Path>,
    files: Vec<MemoryFile>,
}

impl Scan<'_> {
    /// A `CLAUDE.md` / `AGENTS.md` and what it imports. `loaded` gets every
    /// file that was read.
    fn instructions(&mut self, path: &Path, loaded: &mut Vec<PathBuf>) {
        if path.is_file() {
            self.load_tree(
                path,
                MemoryKind::Instructions,
                None,
                0,
                &mut Vec::new(),
                loaded,
            );
        }
    }

    fn load_tree(
        &mut self,
        path: &Path,
        kind: MemoryKind,
        parent: Option<&Path>,
        depth: usize,
        stack: &mut Vec<PathBuf>,
        loaded: &mut Vec<PathBuf>,
    ) {
        let Ok(raw) = fs::read(path) else { return };
        loaded.push(path.to_path_buf());
        // Each file is listed and checked once, even when two trees reach it.
        let is_new = !self.files.iter().any(|f| f.path == path);
        let slot = self.files.len();
        if is_new {
            let file = self.new_file(path, kind, parent, &raw);
            self.files.push(file);
        }
        let mut issues = Vec::new();
        if depth < MAX_IMPORT_DEPTH {
            let text = String::from_utf8_lossy(&raw);
            let dir = path.parent().unwrap_or(path);
            stack.push(path.to_path_buf());
            for (line, token) in import_lines(&text) {
                let Some(lexical) = self.resolve(dir, &token[1..]) else {
                    continue;
                };
                let outside = |scan: &mut Self, target: &Path, issues: &mut Vec<MemoryIssue>| {
                    if is_new {
                        issues.push(MemoryIssue {
                            line,
                            kind: IssueKind::ImportOutside,
                            target: token.to_owned(),
                        });
                    }
                    scan.list_unread(target, path);
                };
                if !self.inside_roots(&lexical) {
                    outside(self, &lexical, &mut issues);
                    continue;
                }
                // Links and case are settled by the real path; a missing file is not an import.
                let Ok(canon) = lexical.canonicalize() else {
                    continue;
                };
                if !canon.is_file() {
                    continue;
                }
                if !self.inside_roots(&plain(&canon)) {
                    outside(self, &plain(&canon), &mut issues);
                } else if stack.contains(&canon) {
                    if is_new {
                        issues.push(MemoryIssue {
                            line,
                            kind: IssueKind::ImportCycle,
                            target: token.to_owned(),
                        });
                    }
                } else {
                    self.load_tree(
                        &canon,
                        MemoryKind::Import,
                        Some(path),
                        depth + 1,
                        stack,
                        loaded,
                    );
                }
            }
            stack.pop();
        }
        if is_new {
            self.files[slot].issues = issues;
        }
    }

    fn auto_memory(&mut self, path: &Path, kind: MemoryKind, dir: &Path) {
        let Ok(raw) = fs::read(path) else { return };
        let mut file = self.new_file(path, kind, None, &raw);
        let text = String::from_utf8_lossy(&raw);
        file.issues = match kind {
            MemoryKind::AutoIndex => missing_index_targets(&text, dir),
            _ => missing_paths(&text),
        };
        self.files.push(file);
    }

    /// An import outside every root: listed, never opened.
    fn list_unread(&mut self, target: &Path, parent: &Path) {
        if self.files.iter().any(|f| f.path == target) {
            return;
        }
        self.files.push(MemoryFile {
            path: target.to_path_buf(),
            home_id: None,
            kind: MemoryKind::Import,
            parent: Some(parent.to_path_buf()),
            bytes: 0,
            tokens: 0,
            hash: String::new(),
            issues: Vec::new(),
            differs_in: Vec::new(),
        });
    }

    fn new_file(
        &self,
        path: &Path,
        kind: MemoryKind,
        parent: Option<&Path>,
        raw: &[u8],
    ) -> MemoryFile {
        let bytes = raw.len() as u64;
        MemoryFile {
            path: path.to_path_buf(),
            home_id: self
                .homes
                .iter()
                .find(|h| path.starts_with(&h.path))
                .map(|h| h.id.clone()),
            kind,
            parent: parent.map(Path::to_path_buf),
            bytes,
            tokens: approx_tokens(bytes),
            hash: fnv1a_hex(raw),
            issues: Vec::new(),
            differs_in: Vec::new(),
        }
    }

    /// Where an import points, as a plain path with no `.` or `..`. Nothing
    /// is touched on disk. `None` when it cannot be placed (no home for `~`).
    fn resolve(&self, dir: &Path, raw: &str) -> Option<PathBuf> {
        let joined = if raw == "~" || raw.starts_with("~/") || raw.starts_with("~\\") {
            let rest = raw[1..].trim_start_matches(['/', '\\']);
            self.user_home?.join(rest)
        } else {
            let p = Path::new(raw);
            if p.is_absolute() {
                p.to_path_buf()
            } else if p.has_root() {
                return None;
            } else {
                dir.join(p)
            }
        };
        Some(normalize(&plain(&joined)))
    }

    fn inside_roots(&self, path: &Path) -> bool {
        self.roots.iter().any(|r| is_under(r, path))
    }
}

/// `(line, first token)` for each line that starts with `@path`, outside code fences.
fn import_lines(text: &str) -> Vec<(u32, &str)> {
    outside_fences(text)
        .filter_map(|(n, line)| {
            let token = line.split_whitespace().next()?;
            (token.len() > 1 && token.starts_with('@')).then_some((n, token))
        })
        .collect()
}

/// Lines (1-based) that are not inside a ``` or ~~~ fence, nor a fence line.
fn outside_fences(text: &str) -> impl Iterator<Item = (u32, &str)> {
    let mut in_fence = false;
    text.lines().zip(1u32..).filter_map(move |(line, n)| {
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            in_fence = !in_fence;
            return None;
        }
        (!in_fence).then_some((n, line))
    })
}

/// `](x.md)` links in a `MEMORY.md` whose file is not in `dir`.
fn missing_index_targets(text: &str, dir: &Path) -> Vec<MemoryIssue> {
    let mut out = Vec::new();
    for (line, n) in text.lines().zip(1u32..) {
        let mut rest = line;
        while let Some(at) = rest.find("](") {
            rest = &rest[at + 2..];
            let Some(end) = rest.find(')') else { break };
            let target = rest[..end].trim();
            rest = &rest[end..];
            let local = !target.contains("://") && !target.starts_with(['#', '<']);
            if local && target.ends_with(".md") && !dir.join(target).is_file() {
                out.push(MemoryIssue {
                    line: n,
                    kind: IssueKind::MissingIndexTarget,
                    target: target.to_owned(),
                });
            }
        }
    }
    out
}

/// Absolute paths in backticks that do not exist. A span with a space or a
/// glob character is not a path that can be checked, and is skipped, and so is
/// one that starts with a backslash or `//` (a network path; no lookup).
fn missing_paths(text: &str) -> Vec<MemoryIssue> {
    let mut out = Vec::new();
    for (n, line) in outside_fences(text) {
        for span in line.split('`').skip(1).step_by(2) {
            let span = span.trim();
            let checkable = !span.is_empty()
                && !span.contains(char::is_whitespace)
                && !span.contains(['*', '?'])
                && !span.starts_with('\\')
                && !span.starts_with("//");
            if checkable && Path::new(span).is_absolute() && !Path::new(span).exists() {
                out.push(MemoryIssue {
                    line: n,
                    kind: IssueKind::MissingPath,
                    target: span.to_owned(),
                });
            }
        }
    }
    out
}

/// Fills `differs_in`: the other homes with the same relative path and kind
/// but a different hash.
fn mark_differences(files: &mut [MemoryFile], homes: &[Home]) {
    type Key = (PathBuf, &'static str);
    let key = |f: &MemoryFile| -> Option<(String, Key)> {
        let id = f.home_id.as_ref()?;
        let home = homes.iter().find(|h| &h.id == id)?;
        let rel = f.path.strip_prefix(&home.path).ok()?;
        if f.hash.is_empty() {
            return None;
        }
        Some((id.clone(), (rel.to_path_buf(), kind_name(f.kind))))
    };
    let mut groups: HashMap<Key, Vec<(String, String)>> = HashMap::new();
    for f in files.iter() {
        if let Some((id, k)) = key(f) {
            groups.entry(k).or_default().push((id, f.hash.clone()));
        }
    }
    for f in files.iter_mut() {
        if let Some((id, k)) = key(f) {
            f.differs_in = groups[&k]
                .iter()
                .filter(|(other, hash)| *other != id && *hash != f.hash)
                .map(|(other, _)| other.clone())
                .collect();
        }
    }
}

fn kind_name(kind: MemoryKind) -> &'static str {
    match kind {
        MemoryKind::Instructions => "instructions",
        MemoryKind::Import => "import",
        MemoryKind::AutoMemory => "auto_memory",
        MemoryKind::AutoIndex => "auto_index",
    }
}

fn sorted_md_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "md") && p.is_file())
        .collect();
    files.sort();
    files
}

/// Drops the `\\?\` prefix a Windows canonical path carries, so it can be
/// compared with a path typed by a person.
pub(crate) fn plain(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => path.to_path_buf(),
    }
}

/// Removes `.` and `..` without touching the disk.
pub(crate) fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Part by part, and ignoring case on Windows, where paths do.
pub(crate) fn is_under(root: &Path, path: &Path) -> bool {
    let parts = |p: &Path| -> Vec<String> {
        p.components()
            .map(|c| {
                let s = c.as_os_str().to_string_lossy();
                if cfg!(windows) {
                    s.to_lowercase()
                } else {
                    s.into_owned()
                }
            })
            .collect()
    };
    parts(path).starts_with(&parts(root))
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
            path: path.canonicalize().unwrap(),
            source: HomeSource::Own,
        }
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn find<'a>(set: &'a MemorySet, name: &str) -> &'a MemoryFile {
        set.files
            .iter()
            .find(|f| f.path.file_name().is_some_and(|n| n == name))
            .unwrap_or_else(|| panic!("{name} not listed"))
    }

    /// The folder Claude keeps this worktree's memory in, under `home`.
    fn memory_dir(home: &Home, worktree: &Path) -> std::path::PathBuf {
        home.path
            .join("projects")
            .join(project_slug(&worktree.canonicalize().unwrap()))
            .join("memory")
    }

    #[test]
    fn claude_md_imports_resolved() {
        // Long form of the temp path: Windows CI hands out 8.3 names, and
        // imports are resolved through canonical paths.
        let base = dunce::canonicalize(std::env::temp_dir()).unwrap();
        let user = tempfile::tempdir_in(base).unwrap();
        let dir = user.path().join(".claude");
        write(
            &dir.join("CLAUDE.md"),
            "# Rules\n@notes.md\n@~/.claude/tilde.md\n```\n@fenced.md\n```\n",
        );
        write(&dir.join("notes.md"), "see\n@sub/more.md extra words\n");
        write(&dir.join("sub/more.md"), "more");
        write(&dir.join("tilde.md"), "tilde");
        write(&dir.join("fenced.md"), "fenced");
        let h = home("own-claude", Agent::Claude, &dir);
        let set = scan_memory_with(&[h], None, Some(user.path()));

        let root = find(&set, "CLAUDE.md");
        assert_eq!(root.kind, MemoryKind::Instructions);
        assert_eq!(root.home_id.as_deref(), Some("own-claude"));
        assert_eq!(root.parent, None);
        let notes = find(&set, "notes.md");
        assert_eq!(notes.kind, MemoryKind::Import);
        assert_eq!(notes.parent.as_deref(), Some(root.path.as_path()));
        let more = find(&set, "more.md");
        assert_eq!(more.parent.as_deref(), Some(notes.path.as_path()));
        assert_eq!(
            find(&set, "tilde.md").parent.as_deref(),
            Some(root.path.as_path())
        );
        assert!(
            set.files
                .iter()
                .all(|f| f.path.file_name().unwrap() != "fenced.md")
        );
        assert_eq!(set.files.len(), 4);
        assert!(root.issues.is_empty());
    }

    #[test]
    fn import_cycle_is_cut() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(".claude");
        write(&dir.join("CLAUDE.md"), "@a.md\n");
        write(&dir.join("a.md"), "a\n@b.md\n");
        write(&dir.join("b.md"), "b\n\n@a.md\n");
        let h = home("own-claude", Agent::Claude, &dir);
        let set = scan_memory_with(&[h], None, None);

        // CLAUDE.md, a, b: a -> b -> a is cut at the second `a`.
        assert_eq!(set.files.len(), 3);
        let cycles: Vec<(&Path, &MemoryIssue)> = set
            .files
            .iter()
            .flat_map(|f| f.issues.iter().map(move |i| (f.path.as_path(), i)))
            .filter(|(_, i)| i.kind == IssueKind::ImportCycle)
            .collect();
        assert_eq!(cycles.len(), 1);
        assert!(cycles[0].0.ends_with("b.md"));
        assert_eq!(cycles[0].1.line, 3);
        assert_eq!(cycles[0].1.target, "@a.md");
    }

    #[test]
    fn two_file_cycle_gives_two_files_and_one_mark() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(".claude");
        write(&dir.join("CLAUDE.md"), "@b.md\n");
        write(&dir.join("b.md"), "@CLAUDE.md\n");
        let h = home("own-claude", Agent::Claude, &dir);
        let set = scan_memory_with(&[h], None, None);
        assert_eq!(set.files.len(), 2);
        let cycles = set
            .files
            .iter()
            .flat_map(|f| &f.issues)
            .filter(|i| i.kind == IssueKind::ImportCycle)
            .count();
        assert_eq!(cycles, 1);
    }

    #[test]
    fn import_outside_roots_is_not_read() {
        let tmp = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(".claude");
        let secret = elsewhere.path().join("secret.md");
        write(&secret, &"s".repeat(500));
        write(
            &dir.join("CLAUDE.md"),
            &format!("@{}\n@../up.md\n", secret.display()),
        );
        write(&tmp.path().join("up.md"), "up");
        let h = home("own-claude", Agent::Claude, &dir);
        let set = scan_memory_with(&[h], None, None);

        let root = find(&set, "CLAUDE.md");
        let outside: Vec<u32> = root
            .issues
            .iter()
            .filter(|i| i.kind == IssueKind::ImportOutside)
            .map(|i| i.line)
            .collect();
        assert_eq!(outside, [1, 2]);
        let listed = find(&set, "secret.md");
        assert_eq!(listed.kind, MemoryKind::Import);
        assert_eq!((listed.bytes, listed.tokens), (0, 0));
        assert!(listed.hash.is_empty());
        assert_eq!(set.load_tokens, approx_tokens(root.bytes));
    }

    #[test]
    fn index_line_to_missing_file_is_flagged() {
        let tmp = tempfile::tempdir().unwrap();
        let wt = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(".claude");
        fs::create_dir_all(&dir).unwrap();
        let h = home("own-claude", Agent::Claude, &dir);
        let mem = memory_dir(&h, wt.path());
        write(
            &mem.join("MEMORY.md"),
            "- [A](a.md) - one\n- [B](b.md) and [C](c.md)\n- [Web](https://x.test/y.md)\n",
        );
        write(&mem.join("a.md"), "a");
        write(&mem.join("c.md"), "c");
        let set = scan_memory_with(&[h], Some(wt.path()), None);

        let index = find(&set, "MEMORY.md");
        assert_eq!(index.kind, MemoryKind::AutoIndex);
        assert_eq!(
            index.issues,
            [MemoryIssue {
                line: 2,
                kind: IssueKind::MissingIndexTarget,
                target: "b.md".into()
            }]
        );
        assert_eq!(find(&set, "a.md").kind, MemoryKind::AutoMemory);
    }

    #[test]
    fn unc_path_is_not_checked() {
        // A network path is never looked up: no issue, and no wait for a host.
        let text = "See `\\\\no-such-host.invalid\\share\\file.txt` and `//no-such-host.invalid/share/f.txt`.\n";
        assert!(missing_paths(text).is_empty());
    }

    #[test]
    fn missing_absolute_path_flagged_in_auto_memory() {
        let tmp = tempfile::tempdir().unwrap();
        let wt = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(".claude");
        fs::create_dir_all(&dir).unwrap();
        let h = home("own-claude", Agent::Claude, &dir);
        let mem = memory_dir(&h, wt.path());
        let present = plain(&wt.path().canonicalize().unwrap());
        let gone = present.join("no-such-folder").join("file.txt");
        let line = format!(
            "Uses `{}` and `{}` and `relative/x.txt`.\n",
            present.display(),
            gone.display()
        );
        write(&mem.join("note.md"), &line);
        write(&dir.join("CLAUDE.md"), &line);
        let set = scan_memory_with(&[h], Some(wt.path()), None);

        let note = find(&set, "note.md");
        assert_eq!(
            note.issues,
            [MemoryIssue {
                line: 1,
                kind: IssueKind::MissingPath,
                target: gone.display().to_string()
            }]
        );
        // Only auto memory files are checked.
        assert!(find(&set, "CLAUDE.md").issues.is_empty());
    }

    #[test]
    fn differs_across_account_homes() {
        let tmp = tempfile::tempdir().unwrap();
        let wt = tempfile::tempdir().unwrap();
        let (da, db) = (tmp.path().join("a"), tmp.path().join("b"));
        write(&da.join("CLAUDE.md"), "one");
        write(&db.join("CLAUDE.md"), "two");
        let (ha, hb) = (
            home("acct-a", Agent::Claude, &da),
            home("acct-b", Agent::Claude, &db),
        );
        for h in [&ha, &hb] {
            write(&memory_dir(h, wt.path()).join("same.md"), "same");
        }
        let set = scan_memory_with(&[ha, hb], Some(wt.path()), None);

        let claude: Vec<&MemoryFile> = set
            .files
            .iter()
            .filter(|f| f.path.ends_with("CLAUDE.md"))
            .collect();
        assert_eq!(claude.len(), 2);
        assert_eq!(claude[0].differs_in, ["acct-b"]);
        assert_eq!(claude[1].differs_in, ["acct-a"]);
        let same: Vec<&MemoryFile> = set
            .files
            .iter()
            .filter(|f| f.path.ends_with("same.md"))
            .collect();
        assert_eq!(same.len(), 2);
        assert!(same.iter().all(|f| f.differs_in.is_empty()));
    }

    #[test]
    fn load_tokens_sums_session_files() {
        let tmp = tempfile::tempdir().unwrap();
        let wt = tempfile::tempdir().unwrap();
        let (c1, c2, cx) = (
            tmp.path().join("c1"),
            tmp.path().join("c2"),
            tmp.path().join("cx"),
        );
        write(&c1.join("CLAUDE.md"), "@import.md\n"); // 11 bytes: 3
        write(&c1.join("import.md"), "aaaa"); // 1
        write(&c2.join("CLAUDE.md"), &"z".repeat(400)); // another home: not counted
        write(&cx.join("AGENTS.md"), &"y".repeat(400)); // Codex: not counted
        write(&wt.path().join("CLAUDE.md"), &"b".repeat(12)); // 3
        write(&wt.path().join("AGENTS.md"), &"w".repeat(400)); // not loaded by Claude
        let h1 = home("acct-1", Agent::Claude, &c1);
        let h2 = home("acct-2", Agent::Claude, &c2);
        let hx = home("acct-x", Agent::Codex, &cx);
        let mem = memory_dir(&h1, wt.path());
        write(&mem.join("MEMORY.md"), &"c".repeat(20)); // 5
        write(&mem.join("topic.md"), &"t".repeat(400)); // loads on demand: not counted
        let set = scan_memory_with(&[h1, h2, hx], Some(wt.path()), None);

        assert_eq!(set.load_tokens, 3 + 1 + 3 + 5);
        // Everything is still listed.
        assert!(set.files.iter().any(|f| f.path.ends_with("topic.md")));
        assert!(set.files.iter().any(|f| f.path.ends_with("AGENTS.md")));
    }

    #[test]
    fn worktree_files_have_no_home() {
        let wt = tempfile::tempdir().unwrap();
        write(&wt.path().join(".claude/CLAUDE.md"), "x");
        let set = scan_memory_with(&[], Some(wt.path()), None);
        assert_eq!(set.files.len(), 1);
        assert_eq!(set.files[0].home_id, None);
        assert_eq!(set.files[0].kind, MemoryKind::Instructions);
    }

    #[cfg(windows)]
    #[test]
    fn project_slug_matches_observed_form() {
        assert_eq!(project_slug(Path::new(r"E:\Codes\xDev")), "E--Codes-xDev");
        assert_eq!(
            project_slug(Path::new(r"C:\Users\duytd20\.xdev-hive")),
            "C--Users-duytd20--xdev-hive"
        );
    }
}
