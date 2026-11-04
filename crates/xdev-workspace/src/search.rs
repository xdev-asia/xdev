//! Quick open and search in files for one worktree: a walk that respects
//! `.gitignore`, skips `.git` and never follows a link out of the worktree.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use ignore::WalkBuilder;
use ignore::overrides::{Override, OverrideBuilder};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

use crate::WorkspaceError;

/// `list_files` stops here and sets `truncated`.
pub const LIST_MAX: usize = 50_000;
/// Lines in total over one search.
pub const HIT_MAX: usize = 5_000;
/// Lines kept per file; `more` tells there were others.
pub const PER_FILE_MAX: usize = 200;
/// Chars of a line kept around its first match.
pub const LINE_CLIP: usize = 400;

/// The files of a worktree for quick open.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FileList {
    /// Relative, forward slashes, sorted.
    pub files: Vec<String>,
    /// More than `LIST_MAX` files; only the first ones are listed.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    /// 1 to 1000 chars.
    pub text: String,
    pub case_sensitive: bool,
    pub whole_word: bool,
    /// `text` is a regex (the `regex` crate's syntax) rather than plain text.
    pub regex: bool,
    /// Gitignore-style globs such as `*.ts` or `src/**`; empty is every file.
    pub include: Vec<String>,
    /// Globs left out, on top of `.gitignore`.
    pub exclude: Vec<String>,
}

/// One matching line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LineHit {
    /// 1-based.
    pub line: u32,
    /// The line without its break, clipped to `LINE_CLIP` chars around the first match.
    pub text: String,
    /// Each match as `[start, end)` char offsets in `text`.
    pub ranges: Vec<(u32, u32)>,
}

/// The matching lines of one file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FileHits {
    pub rel: String,
    pub hits: Vec<LineHit>,
    /// The file has more matching lines than `PER_FILE_MAX`.
    pub more: bool,
}

/// What a search sends while it runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SearchEvent {
    Batch {
        files: Vec<FileHits>,
    },
    /// The last event of a search that was not cancelled; `truncated` when
    /// `HIT_MAX` was reached.
    Done {
        files: u32,
        hits: u32,
        truncated: bool,
        ms: u32,
    },
    /// The query cannot run (a bad regex or glob); nothing follows.
    Error {
        message: String,
    },
}

/// Every file of `worktree` that `.gitignore` keeps, up to `LIST_MAX`.
pub fn list_files(worktree: &str) -> Result<FileList, WorkspaceError> {
    list_capped(Path::new(worktree), LIST_MAX)
}

fn list_capped(root: &Path, max: usize) -> Result<FileList, WorkspaceError> {
    let mut files = Vec::new();
    let mut truncated = false;
    for (_, rel) in walk(root, None)? {
        if files.len() == max {
            truncated = true;
            break;
        }
        files.push(rel);
    }
    files.sort();
    Ok(FileList { files, truncated })
}

/// The files under `root` as `(path, rel)`: `.gitignore`, `.git/info/exclude`
/// and the global excludes apply, dot files are kept, `.git` and links are
/// skipped (a link is never followed, so nothing outside `root` is reached).
/// `filter`, when set, drops what it marks as ignored on top of that.
fn walk(
    root: &Path,
    filter: Option<Override>,
) -> Result<impl Iterator<Item = (PathBuf, String)>, WorkspaceError> {
    // A missing root must fail loudly, not look like an empty worktree.
    if !fs::metadata(root)?.is_dir() {
        return Err(WorkspaceError::BadPath(root.to_string_lossy().into_owned()));
    }
    let base = root.to_owned();
    let walker = WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_exclude(true)
        .require_git(false)
        .follow_links(false)
        .sort_by_file_name(|a, b| a.cmp(b))
        .filter_entry(move |e| {
            let is_dir = e.file_type().is_some_and(|t| t.is_dir());
            if is_dir && e.file_name() == ".git" {
                return false;
            }
            filter
                .as_ref()
                .is_none_or(|f| !f.matched(e.path(), is_dir).is_ignore())
        })
        .build();
    Ok(walker.filter_map(move |entry| {
        // One unreadable folder or a file deleted mid-walk does not hide the rest.
        let entry = entry.ok()?;
        if !entry.file_type()?.is_file() {
            return None;
        }
        let rel = rel_of(&base, entry.path())?;
        Some((entry.into_path(), rel))
    }))
}

/// `path` relative to `root` with `/` between parts.
fn rel_of(root: &Path, path: &Path) -> Option<String> {
    let parts: Vec<_> = path
        .strip_prefix(root)
        .ok()?
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect();
    Some(parts.join("/"))
}

/// Longest `SearchQuery::text`, in chars.
const QUERY_MAX: usize = 1000;
/// Compiled size a query regex may take; past it the query is refused.
const REGEX_SIZE_MAX: usize = 1 << 20;

/// A query ready to run: one regex for every mode and the glob filter.
struct Compiled {
    re: Regex,
    filter: Override,
}

/// Builds the regex (plain text escaped, `\b…\b` for a whole word, case
/// folded unless asked) and the include / exclude filter of `q`. The error
/// is the message shown to the person.
fn compile(root: &Path, q: &SearchQuery) -> Result<Compiled, String> {
    let len = q.text.chars().count();
    if len == 0 || len > QUERY_MAX {
        return Err(format!(
            "the search text must be 1 to {QUERY_MAX} characters"
        ));
    }
    let mut pattern = if q.regex {
        q.text.clone()
    } else {
        regex::escape(&q.text)
    };
    if q.whole_word {
        pattern = format!(r"\b(?:{pattern})\b");
    }
    let re = RegexBuilder::new(&pattern)
        .case_insensitive(!q.case_sensitive)
        .size_limit(REGEX_SIZE_MAX)
        .build()
        .map_err(|e| e.to_string())?;
    let mut globs = OverrideBuilder::new(root);
    for g in &q.include {
        globs.add(g).map_err(|e| e.to_string())?;
    }
    for g in &q.exclude {
        globs.add(&format!("!{g}")).map_err(|e| e.to_string())?;
    }
    let filter = globs.build().map_err(|e| e.to_string())?;
    Ok(Compiled { re, filter })
}

/// Searches the text files of `worktree` for `q`, sending `Batch` events and
/// then `Done` to `sink`. Stops early without `Done` once `cancel` is set.
pub fn search_text(
    worktree: &str,
    q: &SearchQuery,
    cancel: &AtomicBool,
    sink: &mut dyn FnMut(SearchEvent),
) -> Result<(), WorkspaceError> {
    let compiled = match compile(Path::new(worktree), q) {
        Ok(c) => c,
        Err(message) => {
            sink(SearchEvent::Error { message });
            return Ok(());
        }
    };
    // The walk itself comes with the next step.
    let _ = (cancel, &compiled.re, &compiled.filter);
    sink(SearchEvent::Done {
        files: 0,
        hits: 0,
        truncated: false,
        ms: 0,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use tempfile::TempDir;

    use super::*;

    fn put(root: &Path, rel: &str, text: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn root(tmp: &TempDir) -> &str {
        tmp.path().to_str().unwrap()
    }

    /// A worktree with a `.gitignore`, a `.git` folder, a dot file and nesting.
    fn tree() -> TempDir {
        let tmp = TempDir::new().unwrap();
        let r = tmp.path();
        put(r, ".gitignore", "target/\n*.log\n");
        put(r, ".git/HEAD", "ref: refs/heads/main\n");
        put(r, ".git/config", "");
        put(r, ".env.example", "KEY=\n");
        put(r, "README.md", "hi\n");
        put(r, "src/main.rs", "fn main() {}\n");
        put(r, "src/deep/mod.rs", "\n");
        put(r, "target/debug/out.rs", "fn main() {}\n");
        put(r, "debug.log", "x\n");
        tmp
    }

    #[test]
    fn list_files_keeps_what_gitignore_keeps_sorted_with_forward_slashes() {
        let tmp = tree();
        assert_eq!(
            list_files(root(&tmp)).unwrap(),
            FileList {
                files: vec![
                    ".env.example".into(),
                    ".gitignore".into(),
                    "README.md".into(),
                    "src/deep/mod.rs".into(),
                    "src/main.rs".into(),
                ],
                truncated: false,
            }
        );
    }

    #[test]
    fn list_files_stops_at_the_cap() {
        let tmp = tree();
        let out = list_capped(tmp.path(), 3).unwrap();
        assert_eq!(out.files.len(), 3);
        assert!(out.truncated);
        let all = list_capped(tmp.path(), 5).unwrap();
        assert_eq!(all.files.len(), 5);
        assert!(!all.truncated);
    }

    #[test]
    fn list_files_refuses_a_missing_worktree() {
        let tmp = TempDir::new().unwrap();
        let gone = tmp.path().join("gone");
        assert!(list_files(gone.to_str().unwrap()).is_err());
    }

    /// A link out of the worktree is neither listed nor walked into. Skipped
    /// where the OS does not let this user make links (Windows without
    /// developer mode).
    #[test]
    fn list_files_does_not_follow_links_out_of_the_worktree() {
        let outside = TempDir::new().unwrap();
        put(outside.path(), "secret.txt", "s\n");
        let tmp = tree();
        let dir_link = tmp.path().join("out");
        let file_link = tmp.path().join("secret.txt");
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(outside.path(), &dir_link).is_ok()
            && std::os::unix::fs::symlink(outside.path().join("secret.txt"), &file_link).is_ok();
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_dir(outside.path(), &dir_link).is_ok()
            && std::os::windows::fs::symlink_file(outside.path().join("secret.txt"), &file_link)
                .is_ok();
        if !made {
            eprintln!("skipped: this user cannot make links");
            return;
        }
        let files = list_files(root(&tmp)).unwrap().files;
        assert!(files.iter().all(|f| !f.contains("secret")), "{files:?}");
        assert!(!files.iter().any(|f| f.starts_with("out")), "{files:?}");
    }

    fn query(text: &str) -> SearchQuery {
        SearchQuery {
            text: text.into(),
            case_sensitive: false,
            whole_word: false,
            regex: false,
            include: vec![],
            exclude: vec![],
        }
    }

    fn matches(q: &SearchQuery, line: &str) -> bool {
        compile(Path::new("."), q).unwrap().re.is_match(line)
    }

    #[test]
    fn plain_text_matches_only_the_literal() {
        let q = query("foo.bar");
        assert!(matches(&q, "x foo.bar y"));
        assert!(!matches(&q, "fooxbar"));
        assert!(matches(&query("a(b"), "a(b"));
    }

    #[test]
    fn regex_mode_uses_the_pattern() {
        let q = SearchQuery {
            regex: true,
            ..query("fo+")
        };
        assert!(matches(&q, "foooo"));
        assert!(!matches(&q, "f"));
    }

    #[test]
    fn whole_word_skips_longer_words() {
        let q = SearchQuery {
            whole_word: true,
            ..query("foo")
        };
        assert!(matches(&q, "a foo b"));
        assert!(!matches(&q, "foobar"));
        assert!(!matches(&q, "dir_foo"));
        let alt = SearchQuery {
            whole_word: true,
            regex: true,
            ..query("foo|bar")
        };
        assert!(!matches(&alt, "foox xbar"));
    }

    #[test]
    fn case_is_ignored_unless_asked() {
        assert!(matches(&query("foo"), "FOO"));
        let q = SearchQuery {
            case_sensitive: true,
            ..query("foo")
        };
        assert!(!matches(&q, "FOO"));
        assert!(matches(&q, "foo"));
    }

    fn errors_of(tmp: &TempDir, q: &SearchQuery) -> Vec<SearchEvent> {
        let mut seen = Vec::new();
        search_text(root(tmp), q, &AtomicBool::new(false), &mut |e| seen.push(e)).unwrap();
        seen
    }

    fn is_one_error(seen: &[SearchEvent]) -> bool {
        matches!(seen, [SearchEvent::Error { message }] if !message.is_empty())
    }

    #[test]
    fn a_bad_regex_or_glob_or_text_sends_one_error() {
        let tmp = tree();
        let bad_re = SearchQuery {
            regex: true,
            ..query("(")
        };
        assert!(is_one_error(&errors_of(&tmp, &bad_re)));
        let bad_glob = SearchQuery {
            include: vec!["a[".into()],
            ..query("x")
        };
        assert!(is_one_error(&errors_of(&tmp, &bad_glob)));
        assert!(is_one_error(&errors_of(&tmp, &query(""))));
        assert!(is_one_error(&errors_of(&tmp, &query(&"x".repeat(1001)))));
        // A huge pattern hits the size limit instead of eating memory.
        let huge = SearchQuery {
            regex: true,
            ..query(r"(\w{100}){100}")
        };
        assert!(is_one_error(&errors_of(&tmp, &huge)));
    }

    #[test]
    fn include_and_exclude_globs_filter_the_walk() {
        let tmp = tree();
        put(tmp.path(), "vendor/x.rs", "");
        put(tmp.path(), "lib.rs", "");
        let files = |include: &[&str], exclude: &[&str]| -> Vec<String> {
            let q = SearchQuery {
                include: include.iter().map(|s| s.to_string()).collect(),
                exclude: exclude.iter().map(|s| s.to_string()).collect(),
                ..query("x")
            };
            let filter = compile(tmp.path(), &q).unwrap().filter;
            walk(tmp.path(), Some(filter))
                .unwrap()
                .map(|(_, rel)| rel)
                .collect()
        };
        assert_eq!(
            files(&["src/**/*.rs"], &[]),
            vec!["src/deep/mod.rs", "src/main.rs"]
        );
        assert_eq!(
            files(&["*.rs"], &["vendor", "src/deep"]),
            vec!["lib.rs", "src/main.rs"]
        );
        // An include glob does not bring back what .gitignore leaves out.
        assert_eq!(files(&["*.log"], &[]), Vec::<String>::new());
    }
}
