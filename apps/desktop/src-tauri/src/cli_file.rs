//! `file.open`: shows a file of a known worktree in the window. Resolving
//! the path is pure; the verb only reads the registry and emits the event.

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
use xdev_workspace::path_key;

use crate::cli_verbs::{Ctx, bad_request, params, target};
use crate::commands::CmdError;
use crate::endpoint::{AppError, Caller, Request, caller_worktree};

/// Emitted for the window to open the file.
pub const OPEN_FILE_EVENT: &str = "cli://open-file";

/// The payload of `OPEN_FILE_EVENT`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CliOpenFile {
    pub worktree: String,
    /// Relative to `worktree`, with `/` separators.
    pub path: String,
    pub line: Option<u32>,
    pub column: Option<u32>,
}

/// Shows the main window and puts it in front.
pub fn bring_to_front(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[derive(Deserialize)]
struct OpenParams {
    path: String,
    line: Option<u32>,
    column: Option<u32>,
    cwd: Option<String>,
}

/// `path`, `path:line` or `path:line:column`: the path and the position.
/// A suffix that is not a positive number stays in the path.
pub fn split_position(text: &str) -> (&str, Option<u32>, Option<u32>) {
    let number = |s: &str| s.parse::<u32>().ok().filter(|n| *n > 0);
    if let Some((rest, last)) = text.rsplit_once(':')
        && let Some(last) = number(last)
    {
        if let Some((path, line)) = rest.rsplit_once(':')
            && let Some(line) = number(line)
        {
            return (path, Some(line), Some(last));
        }
        return (rest, Some(last), None);
    }
    (text, None, None)
}

/// `path` without `.` parts and with `..` folded in; none when a `..` would
/// climb above the start of the path.
pub(crate) fn fold(path: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    return None;
                }
            }
            other => out.push(other),
        }
    }
    Some(out)
}

/// The deepest of `worktrees` that holds `key` (a `path_key`).
fn holder<'a>(key: &str, worktrees: &'a [PathBuf]) -> Option<&'a PathBuf> {
    worktrees
        .iter()
        .filter(|w| {
            let k = path_key(w);
            key == k || key.starts_with(&format!("{k}/"))
        })
        .max_by_key(|w| path_key(w).len())
}

/// Where `text` is: the worktree among `worktrees` that holds it, and the path
/// inside. Relative paths start at `cwd`. A path outside every worktree, or
/// with a `..` that leaves the worktree it starts in, is an error.
pub fn locate(
    text: &str,
    cwd: Option<&Path>,
    worktrees: &[PathBuf],
) -> Result<(PathBuf, String), AppError> {
    if text.trim().is_empty() {
        return Err(bad_request("name a file to open"));
    }
    let given = Path::new(text);
    let escapes = || {
        AppError::new(
            "outside_worktree",
            format!("{text} leaves its worktree through .."),
        )
    };
    let full = if given.is_absolute() {
        given.to_owned()
    } else {
        let Some(cwd) = cwd else {
            return Err(bad_request("a relative path needs a current folder"));
        };
        cwd.join(given)
    };
    // Folded by hand so a `..` is judged against the worktrees, not the disk.
    let folded = fold(&full).ok_or_else(escapes)?;
    let key = path_key(&folded);
    // The worktree the text names before any `..` is applied.
    let start = holder(&path_key(&full), worktrees);
    let worktree = match (holder(&key, worktrees), start) {
        (Some(w), Some(s)) if w != s => return Err(escapes()),
        (Some(w), _) => w,
        (None, Some(_)) => return Err(escapes()),
        (None, None) => {
            return Err(AppError::new(
                "outside_worktree",
                format!("{text} is not inside a worktree xDev knows"),
            ));
        }
    };
    let rel = key[path_key(worktree).len()..]
        .trim_start_matches('/')
        .to_owned();
    if rel.is_empty() {
        return Err(bad_request(format!("{text} is a worktree, not a file")));
    }
    Ok((worktree.clone(), rel))
}

/// `file.open`: resolves the path, tells the window to open it and brings
/// the window to the front.
pub fn file_open(ctx: &Ctx<'_>, req: &Request, caller: &Caller) -> Result<Value, AppError> {
    let p: OpenParams = params(req)?;
    let (text, line, column) = split_position(&p.path);
    let (line, column) = (p.line.or(line), p.column.or(column));
    // The CLI sends its own folder; the caller's terminal is the fallback.
    let cwd = p
        .cwd
        .map(PathBuf::from)
        .or_else(|| caller.pty.as_deref().and_then(|id| (ctx.cwd_of)(id)));
    let worktrees: Vec<PathBuf> = ctx
        .listed()?
        .iter()
        .map(|l| PathBuf::from(&l.view.path))
        .collect();
    let (worktree, path) = locate(text, cwd.as_deref(), &worktrees)?;
    let out = CliOpenFile {
        worktree: worktree.display().to_string(),
        path,
        line,
        column,
    };
    (ctx.emit)(OPEN_FILE_EVENT, json!(out));
    (ctx.focus_window)();
    Ok(json!(out))
}

/// At most this many files open at once; the rest are listed, not opened.
pub const OPEN_CHANGED_MAX: usize = 20;

#[derive(Deserialize)]
struct OpenChangedParams {
    /// Id, unique prefix, name or path; default the caller's worktree.
    worktree: Option<String>,
    cwd: Option<String>,
}

/// `file.open-changed`: opens each changed file of a worktree, as git
/// status lists them, in path order. A deleted file has nothing to open;
/// past `OPEN_CHANGED_MAX` the rest are skipped.
pub fn file_open_changed(ctx: &Ctx<'_>, req: &Request, caller: &Caller) -> Result<Value, AppError> {
    let p: OpenChangedParams = params(req)?;
    let me = match ctx.caller_worktree(caller)? {
        Some(me) => Some(me),
        None => match p.cwd.as_deref() {
            Some(d) => caller_worktree(&ctx.registry()?, Path::new(d)),
            None => None,
        },
    };
    let all = ctx.listed()?;
    let l = target(&all, p.worktree.as_deref(), me.as_deref())?;
    let worktree = PathBuf::from(&l.view.path);
    let mut changed = xdev_git::Repo::discover(&worktree)
        .and_then(|r| r.status())
        .map_err(CmdError::from)?;
    changed.sort_by(|a, b| a.path.cmp(&b.path));
    let (mut opened, mut skipped) = (Vec::new(), Vec::new());
    for f in changed {
        let reason = if f.kind == xdev_git::ChangeKind::Deleted {
            Some("deleted")
        } else if !worktree.join(&f.path).is_file() {
            Some("not_a_file")
        } else if opened.len() == OPEN_CHANGED_MAX {
            Some("limit")
        } else {
            None
        };
        if let Some(reason) = reason {
            skipped.push(json!({ "path": f.path, "reason": reason }));
            continue;
        }
        let out = CliOpenFile {
            worktree: worktree.display().to_string(),
            path: f.path,
            line: None,
            column: None,
        };
        (ctx.emit)(OPEN_FILE_EVENT, json!(out));
        opened.push(out.path);
    }
    if !opened.is_empty() {
        (ctx.focus_window)();
    }
    Ok(json!({
        "worktree": worktree.display().to_string(),
        "opened": opened,
        "skipped": skipped,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_verbs::tests::fixture;

    /// An absolute path on this OS: `/a` on Unix, `C:/a` on Windows.
    fn abs(p: &str) -> String {
        if cfg!(windows) {
            format!("C:{p}")
        } else {
            p.to_owned()
        }
    }

    fn wts() -> Vec<PathBuf> {
        vec![
            PathBuf::from(abs("/r/a")),
            PathBuf::from(abs("/r/a/nested")),
            PathBuf::from(abs("/r/b")),
        ]
    }

    #[test]
    fn a_position_suffix_is_split_off() {
        assert_eq!(split_position("a.rs"), ("a.rs", None, None));
        assert_eq!(split_position("a.rs:12"), ("a.rs", Some(12), None));
        assert_eq!(split_position("a.rs:12:3"), ("a.rs", Some(12), Some(3)));
        // Not positive numbers: part of the name.
        assert_eq!(split_position("a.rs:0"), ("a.rs:0", None, None));
        assert_eq!(split_position("a.rs:x"), ("a.rs:x", None, None));
        assert_eq!(split_position("a.rs:1:x"), ("a.rs:1:x", None, None));
        assert_eq!(split_position("a:1:2:3"), ("a:1", Some(2), Some(3)));
        assert_eq!(split_position(":5"), ("", Some(5), None));
    }

    #[test]
    fn a_path_inside_a_worktree_is_split_into_worktree_and_rest() {
        let (w, rel) = locate(&abs("/r/a/src/x.rs"), None, &wts()).unwrap();
        assert_eq!((w, rel.as_str()), (PathBuf::from(abs("/r/a")), "src/x.rs"));
        let (w, rel) = locate("src/./x.rs", Some(Path::new(&abs("/r/b"))), &wts()).unwrap();
        assert_eq!((w, rel.as_str()), (PathBuf::from(abs("/r/b")), "src/x.rs"));
        // The deepest worktree wins.
        let (w, rel) = locate(&abs("/r/a/nested/y"), None, &wts()).unwrap();
        assert_eq!((w, rel.as_str()), (PathBuf::from(abs("/r/a/nested")), "y"));
        // A `..` that stays inside is fine.
        let (_, rel) = locate("../lib/z.rs", Some(Path::new(&abs("/r/a/src"))), &wts()).unwrap();
        assert_eq!(rel, "lib/z.rs");
    }

    #[test]
    fn a_path_outside_every_worktree_is_a_clear_error() {
        let e = locate(&abs("/etc/hosts"), None, &wts()).unwrap_err();
        assert_eq!(e.code, "outside_worktree");
        assert!(e.message.contains("not inside a worktree"), "{}", e.message);
        // `/r/ab` only shares a prefix with `/r/a`.
        assert_eq!(
            locate(&abs("/r/ab/x"), None, &wts()).unwrap_err().code,
            "outside_worktree"
        );
        assert_eq!(locate("x", None, &wts()).unwrap_err().code, "bad_request");
        assert_eq!(locate("  ", None, &wts()).unwrap_err().code, "bad_request");
        // The worktree itself is not a file.
        assert_eq!(
            locate(&abs("/r/a"), None, &wts()).unwrap_err().code,
            "bad_request"
        );
    }

    #[test]
    fn dotdot_that_leaves_the_worktree_is_rejected() {
        let cwd = Some(Path::new("/r/a/src"));
        for text in [
            "../../b/x",
            "../../../etc/passwd",
            "/r/a/../b/x",
            "/r/a/../../x",
            "../../..",
        ] {
            let e = locate(text, cwd, &wts()).unwrap_err();
            assert_eq!(e.code, "outside_worktree", "{text}");
            assert!(e.message.contains(".."), "{text}: {}", e.message);
        }
    }

    #[test]
    fn the_verb_emits_the_event_and_focuses_the_window() {
        let f = fixture();
        let abs = f.lead.join("src").join("m.rs");
        let r = f
            .call(
                None,
                "file.open",
                json!({ "path": format!("{}:7:2", abs.display()), "line": null, "column": 4 }),
            )
            .unwrap();
        assert_eq!(r["worktree"], f.lead.display().to_string());
        assert_eq!(r["path"], "src/m.rs");
        // The flag beats the suffix.
        assert_eq!(
            (r["line"].as_u64(), r["column"].as_u64()),
            (Some(7), Some(4))
        );
        let events = f.events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, OPEN_FILE_EVENT);
        assert_eq!(events[0].1, r);
        assert_eq!(f.focused.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn the_verb_resolves_a_relative_path_from_the_cli_folder() {
        let f = fixture();
        let r = f
            .call(
                None,
                "file.open",
                json!({ "path": "a.txt", "cwd": f.child.display().to_string() }),
            )
            .unwrap();
        assert_eq!(r["worktree"], f.child.display().to_string());
        assert_eq!(r["path"], "a.txt");
        // Without a folder, the caller's terminal gives one.
        let r = f
            .call(Some("p-other"), "file.open", json!({ "path": "a.txt" }))
            .unwrap();
        assert_eq!(r["worktree"], f.other.display().to_string());
    }

    #[test]
    fn the_verb_refuses_outside_paths_without_an_event() {
        let f = fixture();
        let e = f
            .call(None, "file.open", json!({ "path": abs("/etc/hosts") }))
            .unwrap_err();
        assert_eq!(e.code, "outside_worktree");
        let e = f
            .call(
                None,
                "file.open",
                json!({ "path": "../x", "cwd": f.lead.display().to_string() }),
            )
            .unwrap_err();
        assert_eq!(e.code, "outside_worktree");
        assert!(f.events.lock().unwrap().is_empty());
        assert_eq!(f.focused.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[test]
    fn open_changed_opens_each_changed_file_and_skips_deleted_ones() {
        let f = fixture();
        std::fs::write(f.lead.join("a.txt"), "two").unwrap();
        std::fs::create_dir_all(f.lead.join("src")).unwrap();
        std::fs::write(f.lead.join("src").join("new.rs"), "fn main() {}").unwrap();
        let r = f
            .call(Some("p-lead"), "file.open-changed", json!({}))
            .unwrap();
        assert_eq!(r["worktree"], f.lead.display().to_string());
        assert_eq!(r["opened"], json!(["a.txt", "src/new.rs"]));
        assert_eq!(r["skipped"], json!([]));
        let events = f.events.lock().unwrap().clone();
        let paths: Vec<&Value> = events
            .iter()
            .filter(|(e, _)| e == OPEN_FILE_EVENT)
            .map(|(_, p)| &p["path"])
            .collect();
        assert_eq!(paths, [&json!("a.txt"), &json!("src/new.rs")]);
        assert_eq!(f.focused.load(std::sync::atomic::Ordering::SeqCst), 1);

        // By name from outside; a deleted file is listed, not opened.
        std::fs::remove_file(f.other.join("a.txt")).unwrap();
        let r = f
            .call(None, "file.open-changed", json!({ "worktree": "other" }))
            .unwrap();
        assert_eq!(r["opened"], json!([]));
        assert_eq!(
            r["skipped"],
            json!([{ "path": "a.txt", "reason": "deleted" }])
        );
        // Nothing opened: the window stays where it is.
        assert_eq!(f.focused.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn open_changed_stops_at_the_limit_and_finds_the_worktree_by_folder() {
        let f = fixture();
        for n in 0..OPEN_CHANGED_MAX + 2 {
            std::fs::write(f.child.join(format!("f{n:02}.txt")), "x").unwrap();
        }
        let r = f
            .call(
                None,
                "file.open-changed",
                json!({ "cwd": f.child.display().to_string() }),
            )
            .unwrap();
        assert_eq!(r["worktree"], f.child.display().to_string());
        assert_eq!(r["opened"].as_array().unwrap().len(), OPEN_CHANGED_MAX);
        assert_eq!(
            r["skipped"],
            json!([
                { "path": "f20.txt", "reason": "limit" },
                { "path": "f21.txt", "reason": "limit" },
            ])
        );
        let e = f.call(None, "file.open-changed", json!({})).unwrap_err();
        assert_eq!(e.code, "no_worktree");
    }
}
