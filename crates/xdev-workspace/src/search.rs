//! Quick open and search in files for one worktree: a walk that respects
//! `.gitignore`, skips `.git` and never follows a link out of the worktree.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use ignore::WalkBuilder;
use ignore::overrides::{Override, OverrideBuilder};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

use crate::WorkspaceError;
use crate::files::{BINARY_SNIFF, READ_MAX};

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
    search_capped(Path::new(worktree), q, cancel, sink, HIT_MAX)
}

/// A `Batch` goes out once it holds this many files…
const BATCH_FILES: usize = 50;
/// …or this long after the last one, whichever comes first.
const BATCH_EVERY: Duration = Duration::from_millis(100);

fn search_capped(
    root: &Path,
    q: &SearchQuery,
    cancel: &AtomicBool,
    sink: &mut dyn FnMut(SearchEvent),
    hit_max: usize,
) -> Result<(), WorkspaceError> {
    let started = Instant::now();
    let Compiled { re, filter } = match compile(root, q) {
        Ok(c) => c,
        Err(message) => {
            sink(SearchEvent::Error { message });
            return Ok(());
        }
    };
    let cancelled = || cancel.load(Ordering::SeqCst);
    let mut pending: Vec<FileHits> = Vec::new();
    let mut sent_at = Instant::now();
    let (mut files, mut hits, mut truncated) = (0u32, 0usize, false);
    for (path, rel) in walk(root, Some(filter))? {
        if cancelled() {
            return Ok(());
        }
        let Some(text) = read_text(&path) else {
            continue;
        };
        let (found, full) = search_file(&re, &text, rel, hit_max - hits);
        if let Some(found) = found {
            files += 1;
            hits += found.hits.len();
            pending.push(found);
        }
        if full {
            truncated = true;
            break;
        }
        if !pending.is_empty() && (pending.len() >= BATCH_FILES || sent_at.elapsed() >= BATCH_EVERY)
        {
            sink(SearchEvent::Batch {
                files: std::mem::take(&mut pending),
            });
            sent_at = Instant::now();
        }
    }
    if cancelled() {
        return Ok(());
    }
    if !pending.is_empty() {
        sink(SearchEvent::Batch { files: pending });
    }
    sink(SearchEvent::Done {
        files,
        hits: u32::try_from(hits).unwrap_or(u32::MAX),
        truncated,
        ms: u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX),
    });
    Ok(())
}

/// The text of a file worth searching: `None` past `READ_MAX`, for a binary
/// file (a NUL in its head, as the file tab tells one) or one that cannot be
/// read. Text that is not UTF-8 is searched with replacement chars.
fn read_text(path: &Path) -> Option<String> {
    if fs::metadata(path).ok()?.len() > READ_MAX {
        return None;
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(READ_MAX + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    // It grew since the check.
    if bytes.len() as u64 > READ_MAX || bytes[..bytes.len().min(BINARY_SNIFF)].contains(&0) {
        return None;
    }
    Some(match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    })
}

/// The matching lines of one file, at most `PER_FILE_MAX` and `room`; the
/// flag tells that `room` ran out with a match left over.
fn search_file(re: &Regex, text: &str, rel: String, room: usize) -> (Option<FileHits>, bool) {
    let mut found = FileHits {
        rel,
        hits: Vec::new(),
        more: false,
    };
    let mut full = false;
    for (i, line) in text.split('\n').enumerate() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let Some(hit) = line_hit(re, line, i) else {
            continue;
        };
        if found.hits.len() == room {
            full = true;
            break;
        }
        if found.hits.len() == PER_FILE_MAX {
            found.more = true;
            break;
        }
        found.hits.push(hit);
    }
    ((!found.hits.is_empty()).then_some(found), full)
}

/// Line `i` (0-based) as a hit when `re` matches in it, clipped to
/// `LINE_CLIP` chars around the first match, ranges in chars.
fn line_hit(re: &Regex, line: &str, i: usize) -> Option<LineHit> {
    // Byte ranges to char ranges, counting chars once along the line.
    let mut ranges = Vec::new();
    let (mut byte_at, mut char_at) = (0, 0);
    for m in re.find_iter(line) {
        if m.is_empty() {
            continue;
        }
        char_at += line[byte_at..m.start()].chars().count();
        let start = char_at;
        char_at += m.as_str().chars().count();
        byte_at = m.end();
        ranges.push((start, char_at));
    }
    let &(first_start, first_end) = ranges.first()?;
    let total = char_at + line[byte_at..].chars().count();
    let (from, text) = if total <= LINE_CLIP {
        (0, line.to_owned())
    } else {
        let centre = first_start + (first_end - first_start) / 2;
        let from = centre
            .saturating_sub(LINE_CLIP / 2)
            .min(first_start)
            .min(total - LINE_CLIP);
        (from, line.chars().skip(from).take(LINE_CLIP).collect())
    };
    let to = from + LINE_CLIP;
    let ranges = ranges
        .into_iter()
        .filter(|&(s, e)| s < to && e > from)
        .map(|(s, e)| (s.max(from) - from, e.min(to) - from))
        .map(|(s, e)| (to_u32(s), to_u32(e)))
        .collect();
    Some(LineHit {
        line: to_u32(i + 1),
        text,
        ranges,
    })
}

fn to_u32(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
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

    /// Every event of a search of `root` for `q` with `hit_max`.
    fn run(root: &Path, q: &SearchQuery, hit_max: usize) -> Vec<SearchEvent> {
        let mut seen = Vec::new();
        search_capped(
            root,
            q,
            &AtomicBool::new(false),
            &mut |e| seen.push(e),
            hit_max,
        )
        .unwrap();
        seen
    }

    /// The files of every `Batch`, by `rel`, and the `Done` at the end.
    fn split(seen: Vec<SearchEvent>) -> (Vec<FileHits>, Option<(u32, u32, bool)>) {
        let mut files = Vec::new();
        let mut done = None;
        for e in seen {
            assert!(done.is_none(), "an event after done");
            match e {
                SearchEvent::Batch { files: f } => files.extend(f),
                SearchEvent::Done {
                    files,
                    hits,
                    truncated,
                    ..
                } => done = Some((files, hits, truncated)),
                SearchEvent::Error { message } => panic!("error: {message}"),
            }
        }
        files.sort_by(|a, b| a.rel.cmp(&b.rel));
        (files, done)
    }

    fn hit(line: u32, text: &str, ranges: &[(u32, u32)]) -> LineHit {
        LineHit {
            line,
            text: text.into(),
            ranges: ranges.to_vec(),
        }
    }

    #[test]
    fn search_text_sends_hits_by_file_then_done() {
        let tmp = tree();
        put(tmp.path(), "a.txt", "under\nnothing\ndir_under and under\n");
        put(tmp.path(), "b/c.txt", "UNDER\n");
        put(tmp.path(), "target/x.txt", "under\n");
        put(tmp.path(), ".git/under", "under\n");
        let (files, done) = split(run(tmp.path(), &query("under"), HIT_MAX));
        assert_eq!(
            files,
            vec![
                FileHits {
                    rel: "a.txt".into(),
                    hits: vec![
                        hit(1, "under", &[(0, 5)]),
                        hit(3, "dir_under and under", &[(4, 9), (14, 19)]),
                    ],
                    more: false,
                },
                FileHits {
                    rel: "b/c.txt".into(),
                    hits: vec![hit(1, "UNDER", &[(0, 5)])],
                    more: false,
                },
            ]
        );
        assert_eq!(done, Some((2, 3, false)));
        let mut seen = Vec::new();
        search_text(
            root(&tmp),
            &query("under"),
            &AtomicBool::new(false),
            &mut |e| seen.push(e),
        )
        .unwrap();
        assert_eq!(split(seen).0, files);
    }

    #[test]
    fn regex_and_whole_word_reach_the_lines() {
        let tmp = TempDir::new().unwrap();
        put(tmp.path(), "a.rs", "fn dir_under() {}\nlet under = 1;\n");
        let re = SearchQuery {
            regex: true,
            ..query(r"fn \w+_under")
        };
        assert_eq!(split(run(tmp.path(), &re, HIT_MAX)).1, Some((1, 1, false)));
        let word = SearchQuery {
            whole_word: true,
            ..query("under")
        };
        let (files, _) = split(run(tmp.path(), &word, HIT_MAX));
        assert_eq!(files[0].hits, vec![hit(2, "let under = 1;", &[(4, 9)])]);
    }

    #[test]
    fn a_file_keeps_per_file_max_lines_and_says_more() {
        let tmp = TempDir::new().unwrap();
        put(tmp.path(), "many.txt", &"x\n".repeat(PER_FILE_MAX + 5));
        let (files, done) = split(run(tmp.path(), &query("x"), HIT_MAX));
        assert_eq!(files[0].hits.len(), PER_FILE_MAX);
        assert!(files[0].more);
        assert_eq!(done, Some((1, PER_FILE_MAX as u32, false)));
    }

    #[test]
    fn the_hit_cap_stops_the_search_and_says_truncated() {
        let tmp = TempDir::new().unwrap();
        for i in 0..5 {
            put(tmp.path(), &format!("f{i}.txt"), "x\nx\nx\n");
        }
        let (files, done) = split(run(tmp.path(), &query("x"), 7));
        let total: usize = files.iter().map(|f| f.hits.len()).sum();
        assert_eq!(total, 7);
        assert_eq!(done, Some((3, 7, true)));
        // Exactly the cap is not truncated.
        assert_eq!(
            split(run(tmp.path(), &query("x"), 15)).1,
            Some((5, 15, false))
        );
    }

    #[test]
    fn a_cancel_stops_the_search_without_done() {
        let tmp = TempDir::new().unwrap();
        for i in 0..(BATCH_FILES * 3) {
            put(tmp.path(), &format!("f{i:03}.txt"), "x\n");
        }
        let cancel = AtomicBool::new(false);
        let mut seen = Vec::new();
        search_text(root(&tmp), &query("x"), &cancel, &mut |e| {
            cancel.store(true, Ordering::SeqCst);
            seen.push(e);
        })
        .unwrap();
        assert_eq!(seen.len(), 1, "{seen:?}");
        assert!(matches!(seen[0], SearchEvent::Batch { .. }));
        // Set before it starts: nothing at all.
        let mut none = Vec::new();
        search_text(root(&tmp), &query("x"), &AtomicBool::new(true), &mut |e| {
            none.push(e)
        })
        .unwrap();
        assert!(none.is_empty());
    }

    #[test]
    fn batches_hold_at_most_batch_files() {
        let tmp = TempDir::new().unwrap();
        let n = BATCH_FILES * 2 + 1;
        for i in 0..n {
            put(tmp.path(), &format!("f{i:03}.txt"), "x\n");
        }
        let seen = run(tmp.path(), &query("x"), HIT_MAX);
        for e in &seen {
            if let SearchEvent::Batch { files } = e {
                assert!(!files.is_empty() && files.len() <= BATCH_FILES);
            }
        }
        assert_eq!(split(seen).1, Some((n as u32, n as u32, false)));
    }

    #[test]
    fn crlf_lines_lose_the_cr() {
        let tmp = TempDir::new().unwrap();
        put(tmp.path(), "w.txt", "foo\r\nbar foo\r\n");
        let (files, _) = split(run(tmp.path(), &query("foo"), HIT_MAX));
        assert_eq!(
            files[0].hits,
            vec![hit(1, "foo", &[(0, 3)]), hit(2, "bar foo", &[(4, 7)])]
        );
    }

    #[test]
    fn binary_and_large_files_are_skipped() {
        let tmp = TempDir::new().unwrap();
        put(tmp.path(), "small.txt", "needle\n");
        fs::write(tmp.path().join("bin.dat"), b"needle\0\n").unwrap();
        let mut text = "needle\n".repeat(10);
        text.push_str(&" ".repeat(3 * 1024 * 1024));
        fs::write(tmp.path().join("big.txt"), text).unwrap();
        let (files, done) = split(run(tmp.path(), &query("needle"), HIT_MAX));
        let rels: Vec<_> = files.iter().map(|f| f.rel.as_str()).collect();
        assert_eq!(rels, vec!["small.txt"]);
        assert_eq!(done, Some((1, 1, false)));
    }

    #[test]
    fn ranges_count_chars_not_bytes() {
        let tmp = TempDir::new().unwrap();
        put(tmp.path(), "vi.txt", "Tiếng Việt có dấu\n");
        let (files, _) = split(run(tmp.path(), &query("việt"), HIT_MAX));
        assert_eq!(files[0].hits, vec![hit(1, "Tiếng Việt có dấu", &[(6, 10)])]);
    }

    #[test]
    fn a_long_line_is_clipped_around_the_first_match() {
        let tmp = TempDir::new().unwrap();
        let line = format!("{}ếneedle{}", "a".repeat(700), "b".repeat(700));
        put(tmp.path(), "long.txt", &format!("{line}\n"));
        let (files, _) = split(run(tmp.path(), &query("needle"), HIT_MAX));
        let h = &files[0].hits[0];
        assert_eq!(h.text.chars().count(), LINE_CLIP);
        let (s, e) = h.ranges[0];
        let got: String = h
            .text
            .chars()
            .skip(s as usize)
            .take((e - s) as usize)
            .collect();
        assert_eq!(got, "needle");
        assert!((LINE_CLIP / 2 - 10..LINE_CLIP / 2).contains(&(s as usize)));
        // Near the end the window stops at the end of the line.
        let tail = format!("{}needle", "a".repeat(1000));
        put(tmp.path(), "long.txt", &format!("{tail}\n"));
        let (files, _) = split(run(tmp.path(), &query("needle"), HIT_MAX));
        let h = &files[0].hits[0];
        assert!(h.text.ends_with("needle"));
        assert_eq!(h.ranges, vec![(LINE_CLIP as u32 - 6, LINE_CLIP as u32)]);
    }

    #[test]
    fn globs_cannot_reach_out_of_the_worktree() {
        let tmp = TempDir::new().unwrap();
        let wt = tmp.path().join("wt");
        put(&wt, "in.txt", "needle\n");
        put(tmp.path(), "out.txt", "needle\n");
        for include in ["../*", "../out.txt", "/**", "**/*"] {
            let q = SearchQuery {
                include: vec![include.into()],
                ..query("needle")
            };
            let (files, _) = split(run(&wt, &q, HIT_MAX));
            assert!(
                files.iter().all(|f| f.rel == "in.txt"),
                "{include}: {files:?}"
            );
        }
    }

    #[test]
    fn search_text_refuses_a_missing_worktree() {
        let tmp = TempDir::new().unwrap();
        let gone = tmp.path().join("gone");
        let r = search_text(
            gone.to_str().unwrap(),
            &query("x"),
            &AtomicBool::new(false),
            &mut |_| {},
        );
        assert!(r.is_err());
    }
}
