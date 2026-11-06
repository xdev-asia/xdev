//! The files in `<repo>/.xdev/tasks`. Every path is built from a checked id,
//! symlinks are never followed, and every write goes through a temp file and
//! a rename.

use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::frontmatter::{self, TaskDoc, Value};
use crate::model::{
    BoardError, BoardList, BoardTask, Priority, TaskDraft, TaskFull, TaskPatch, TaskStatus,
    Unreadable,
};

pub const TASKS_DIR: &str = ".xdev/tasks";
pub const MAX_FILES: usize = 2000;
pub const MAX_FILE_BYTES: u64 = 256 * 1024;
const PREVIEW_CHARS: usize = 200;
const TITLE_MAX: usize = 300;
const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

/// `^t[a-z2-7]{6}$`
pub fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    b.len() == 7 && b[0] == b't' && b[1..].iter().all(|c| ALPHABET.contains(c))
}

fn new_id() -> Result<String, BoardError> {
    let mut bytes = [0u8; 6];
    getrandom::fill(&mut bytes).map_err(|e| BoardError::Io(e.to_string()))?;
    let mut id = String::from("t");
    id.extend(
        bytes
            .iter()
            .map(|b| char::from(ALPHABET[usize::from(b & 31)])),
    );
    Ok(id)
}

#[derive(Debug, Clone)]
pub struct Board {
    dir: PathBuf,
}

/// The id of a file named `<id>.md`.
fn stem_id(name: &str) -> Option<&str> {
    name.strip_suffix(".md").filter(|s| valid_id(s))
}

fn preview(body: &str) -> String {
    let flat: String = body.split_whitespace().collect::<Vec<_>>().join(" ");
    flat.chars().take(PREVIEW_CHARS).collect()
}

fn single_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clean_labels(labels: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for l in labels {
        let l = single_line(l);
        if !l.is_empty() && !out.contains(&l) {
            out.push(l);
        }
    }
    out
}

fn clean_opt(s: Option<&str>) -> Option<String> {
    s.map(single_line).filter(|s| !s.is_empty())
}

fn with_final_newline(body: &str) -> String {
    if body.is_empty() || body.ends_with('\n') {
        body.to_owned()
    } else {
        format!("{body}\n")
    }
}

impl Board {
    pub fn open(repo_root: &Path) -> Board {
        Board {
            dir: repo_root.join(".xdev").join("tasks"),
        }
    }

    fn path_of(&self, id: &str) -> Result<PathBuf, BoardError> {
        if !valid_id(id) {
            return Err(BoardError::BadId);
        }
        Ok(self.dir.join(format!("{id}.md")))
    }

    /// The doc and task in `path`; refuses links, big files and bad text.
    fn read(&self, path: &Path, id: &str) -> Result<(TaskDoc, BoardTask), BoardError> {
        let meta = fs::symlink_metadata(path)?;
        if !meta.file_type().is_file() {
            return Err(BoardError::NotFound);
        }
        if meta.len() > MAX_FILE_BYTES {
            return Err(BoardError::TooLarge);
        }
        let text = fs::read_to_string(path).map_err(|e| match e.kind() {
            std::io::ErrorKind::InvalidData => BoardError::Parse("not UTF-8 text".into()),
            _ => e.into(),
        })?;
        let doc = frontmatter::parse(&text).map_err(|e| BoardError::Parse(e.to_string()))?;
        let task = task_of(&doc, id)?;
        Ok((doc, task))
    }

    pub fn list(&self) -> BoardList {
        let mut out = BoardList::default();
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return out;
        };
        let mut names: Vec<String> = entries
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| n.ends_with(".md"))
            .collect();
        names.sort();
        names.truncate(MAX_FILES);
        for name in names {
            let file = format!("{TASKS_DIR}/{name}");
            let Some(id) = stem_id(&name) else {
                out.unreadable.push(Unreadable {
                    file,
                    reason: "the file name is not a task id".into(),
                });
                continue;
            };
            match self.read(&self.dir.join(&name), id) {
                Ok((_, task)) => out.tasks.push(task),
                Err(e) => out.unreadable.push(Unreadable {
                    file,
                    reason: match e {
                        BoardError::TooLarge => "larger than 256 KB".into(),
                        e => e.to_string(),
                    },
                }),
            }
        }
        out
    }

    pub fn get(&self, id: &str) -> Result<TaskFull, BoardError> {
        let path = self.path_of(id)?;
        let (doc, task) = self.read(&path, id)?;
        Ok(TaskFull {
            task,
            body: doc.body,
        })
    }

    fn build(
        &self,
        id: &str,
        draft: &TaskDraft,
        now: &str,
    ) -> Result<(String, BoardTask), BoardError> {
        let title = single_line(&draft.title);
        if title.is_empty() || title.chars().count() > TITLE_MAX {
            return Err(BoardError::Parse("the title is empty or too long".into()));
        }
        if draft.body.len() as u64 > MAX_FILE_BYTES - 4096 {
            return Err(BoardError::TooLarge);
        }
        let status = draft.status.unwrap_or(TaskStatus::Backlog);
        let priority = draft.priority.unwrap_or(Priority::P2);
        let assignee = clean_opt(draft.assignee.as_deref());
        let labels = clean_labels(&draft.labels);
        let mut pairs = vec![
            ("id".to_owned(), Value::Str(id.to_owned())),
            ("title".to_owned(), Value::Str(title.clone())),
            ("status".to_owned(), Value::Str(status.as_str().into())),
            ("priority".to_owned(), Value::Str(priority.as_str().into())),
        ];
        if let Some(a) = &assignee {
            pairs.push(("assignee".to_owned(), Value::Str(a.clone())));
        }
        pairs.push(("labels".to_owned(), Value::List(labels.clone())));
        pairs.push(("created".to_owned(), Value::Str(now.to_owned())));
        pairs.push(("updated".to_owned(), Value::Str(now.to_owned())));
        let body = with_final_newline(&draft.body);
        let text = TaskDoc::new(pairs, body.clone()).render();
        let task = BoardTask {
            id: id.to_owned(),
            title,
            status,
            priority,
            assignee,
            labels,
            created: now.to_owned(),
            updated: now.to_owned(),
            branch: None,
            file: format!("{TASKS_DIR}/{id}.md"),
            body_preview: preview(&body),
        };
        Ok((text, task))
    }

    /// A free id: not a file here, and not in `taken`.
    fn free_id(&self, taken: &HashSet<String>) -> Result<String, BoardError> {
        for _ in 0..16 {
            let id = new_id()?;
            if !taken.contains(&id)
                && fs::symlink_metadata(self.dir.join(format!("{id}.md"))).is_err()
            {
                return Ok(id);
            }
        }
        Err(BoardError::Io("no free task id".into()))
    }

    pub fn create(&self, draft: &TaskDraft, now: &str) -> Result<BoardTask, BoardError> {
        let id = self.free_id(&HashSet::new())?;
        let (text, task) = self.build(&id, draft, now)?;
        fs::create_dir_all(&self.dir)?;
        write_atomic(&self.dir, &format!("{id}.md"), text.as_bytes())?;
        Ok(task)
    }

    /// All the drafts are written, or none is.
    pub fn create_many(
        &self,
        drafts: &[TaskDraft],
        now: &str,
    ) -> Result<Vec<BoardTask>, BoardError> {
        let mut taken = HashSet::new();
        let mut built = Vec::new();
        for draft in drafts {
            let id = self.free_id(&taken)?;
            let (text, task) = self.build(&id, draft, now)?;
            taken.insert(id);
            built.push((text, task));
        }
        if built.is_empty() {
            return Ok(Vec::new());
        }
        fs::create_dir_all(&self.dir)?;
        let mut temps: Vec<PathBuf> = Vec::new();
        let cleanup = |temps: &[PathBuf]| {
            for t in temps {
                let _ = fs::remove_file(t);
            }
        };
        for (text, task) in &built {
            let tmp = self.dir.join(format!(".{}.md.tmp", task.id));
            if let Err(e) = write_synced(&tmp, text.as_bytes()) {
                let _ = fs::remove_file(&tmp);
                cleanup(&temps);
                return Err(e.into());
            }
            temps.push(tmp);
        }
        let mut done: Vec<PathBuf> = Vec::new();
        for ((_, task), tmp) in built.iter().zip(&temps) {
            let target = self.dir.join(format!("{}.md", task.id));
            if let Err(e) = fs::rename(tmp, &target) {
                cleanup(&temps);
                for d in &done {
                    let _ = fs::remove_file(d);
                }
                return Err(e.into());
            }
            done.push(target);
        }
        Ok(built.into_iter().map(|(_, t)| t).collect())
    }

    pub fn update(
        &self,
        id: &str,
        patch: &TaskPatch,
        expected_updated: Option<&str>,
        now: &str,
    ) -> Result<BoardTask, BoardError> {
        let path = self.path_of(id)?;
        let (mut doc, current) = self.read(&path, id)?;
        if let Some(expected) = expected_updated
            && expected != current.updated
        {
            return Err(BoardError::Conflict {
                current: Box::new(current),
            });
        }
        if let Some(title) = &patch.title {
            let title = single_line(title);
            if title.is_empty() || title.chars().count() > TITLE_MAX {
                return Err(BoardError::Parse("the title is empty or too long".into()));
            }
            doc.set("title", Value::Str(title));
        }
        if let Some(s) = patch.status {
            doc.set("status", Value::Str(s.as_str().into()));
        }
        if let Some(p) = patch.priority {
            doc.set("priority", Value::Str(p.as_str().into()));
        }
        match &patch.assignee {
            Some(Some(a)) => match clean_opt(Some(a)) {
                Some(a) => doc.set("assignee", Value::Str(a)),
                None => doc.remove("assignee"),
            },
            Some(None) => doc.remove("assignee"),
            None => {}
        }
        if let Some(labels) = &patch.labels {
            doc.set("labels", Value::List(clean_labels(labels)));
        }
        match &patch.branch {
            Some(Some(b)) => match clean_opt(Some(b)) {
                Some(b) => doc.set("branch", Value::Str(b)),
                None => doc.remove("branch"),
            },
            Some(None) => doc.remove("branch"),
            None => {}
        }
        if let Some(body) = &patch.body {
            doc.body = with_final_newline(body);
        }
        if doc.get("id").is_none() {
            doc.set("id", Value::Str(id.to_owned()));
        }
        doc.set("updated", Value::Str(now.to_owned()));
        let text = doc.render();
        if text.len() as u64 > MAX_FILE_BYTES {
            return Err(BoardError::TooLarge);
        }
        let task = task_of(&doc, id)?;
        write_atomic(&self.dir, &format!("{id}.md"), text.as_bytes())?;
        Ok(task)
    }

    pub fn delete(&self, id: &str) -> Result<(), BoardError> {
        let path = self.path_of(id)?;
        let meta = fs::symlink_metadata(&path)?;
        if meta.file_type().is_dir() {
            return Err(BoardError::NotFound);
        }
        fs::remove_file(&path)?;
        Ok(())
    }
}

fn task_of(doc: &TaskDoc, id: &str) -> Result<BoardTask, BoardError> {
    let bad = |what: &str| BoardError::Parse(what.to_owned());
    if let Some(fm_id) = doc.get_str("id")
        && fm_id != id
    {
        return Err(bad("the id does not match the file name"));
    }
    let title = single_line(doc.get_str("title").unwrap_or(""));
    if title.is_empty() {
        return Err(bad("the title is missing"));
    }
    let status = match doc.get_str("status") {
        None | Some("") => TaskStatus::Backlog,
        Some(s) => TaskStatus::parse(s).ok_or_else(|| bad("the status is not known"))?,
    };
    let priority = match doc.get_str("priority") {
        None | Some("") => Priority::P2,
        Some(p) => Priority::parse(p).ok_or_else(|| bad("the priority is not known"))?,
    };
    let labels = match doc.get("labels") {
        Some(Value::List(items)) => clean_labels(items),
        Some(Value::Str(s)) => clean_labels(std::slice::from_ref(s)),
        None => Vec::new(),
    };
    Ok(BoardTask {
        id: id.to_owned(),
        title,
        status,
        priority,
        assignee: clean_opt(doc.get_str("assignee")),
        labels,
        created: doc.get_str("created").unwrap_or("").to_owned(),
        updated: doc.get_str("updated").unwrap_or("").to_owned(),
        branch: clean_opt(doc.get_str("branch")),
        file: format!("{TASKS_DIR}/{id}.md"),
        body_preview: preview(&doc.body),
    })
}

fn write_synced(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = fs::File::create(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// A temp file in the same folder, then a rename over the target.
fn write_atomic(dir: &Path, name: &str, bytes: &[u8]) -> Result<(), BoardError> {
    let tmp = dir.join(format!(".{name}.tmp"));
    let run = || -> std::io::Result<()> {
        write_synced(&tmp, bytes)?;
        fs::rename(&tmp, dir.join(name))
    };
    run().map_err(|e| {
        let _ = fs::remove_file(&tmp);
        BoardError::from(e)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: &str = "2026-11-06T09:00:00Z";
    const T1: &str = "2026-11-06T10:00:00Z";

    fn draft(title: &str) -> TaskDraft {
        TaskDraft {
            title: title.into(),
            ..TaskDraft::default()
        }
    }

    fn setup() -> (tempfile::TempDir, Board) {
        let dir = tempfile::tempdir().unwrap();
        let board = Board::open(dir.path());
        (dir, board)
    }

    fn files(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir.join(".xdev/tasks"))
            .map(|r| {
                r.filter_map(Result::ok)
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        v.sort();
        v
    }

    #[test]
    fn ids_follow_the_pattern() {
        assert!(valid_id("t7k2m4q"));
        assert!(!valid_id("T1234567"));
        assert!(!valid_id("../x"));
        assert!(!valid_id("t7k2m4"));
        assert!(!valid_id("t7k2m81"));
        for _ in 0..50 {
            assert!(valid_id(&new_id().unwrap()));
        }
    }

    #[test]
    fn create_list_get_update_delete() {
        let (dir, board) = setup();
        assert_eq!(board.list(), BoardList::default());
        let d = TaskDraft {
            title: "Fix: the loop".into(),
            status: Some(TaskStatus::Todo),
            priority: Some(Priority::P1),
            assignee: Some("claude".into()),
            labels: vec!["auth".into(), "bug".into()],
            body: "What is wrong".into(),
        };
        let t = board.create(&d, T0).unwrap();
        assert!(valid_id(&t.id));
        assert_eq!(t.file, format!(".xdev/tasks/{}.md", t.id));
        let list = board.list();
        assert_eq!(list.tasks, vec![t.clone()]);
        let full = board.get(&t.id).unwrap();
        assert_eq!(full.task, t);
        assert_eq!(full.body, "What is wrong\n");
        assert_eq!(t.body_preview, "What is wrong");

        let patch = TaskPatch {
            status: Some(TaskStatus::Done),
            assignee: Some(None),
            branch: Some(Some("fix-loop".into())),
            body: Some("New body\n\nmore".into()),
            ..TaskPatch::default()
        };
        let u = board.update(&t.id, &patch, Some(T0), T1).unwrap();
        assert_eq!(u.status, TaskStatus::Done);
        assert_eq!(u.assignee, None);
        assert_eq!(u.branch.as_deref(), Some("fix-loop"));
        assert_eq!(u.updated, T1);
        assert_eq!(u.created, T0);
        assert_eq!(u.title, "Fix: the loop");
        assert_eq!(board.get(&t.id).unwrap().body, "New body\n\nmore\n");

        board.delete(&t.id).unwrap();
        assert_eq!(board.list(), BoardList::default());
        assert_eq!(board.delete(&t.id), Err(BoardError::NotFound));
        assert_eq!(files(dir.path()), Vec::<String>::new());
    }

    #[test]
    fn update_keeps_unknown_keys_and_the_body() {
        let (dir, board) = setup();
        let t = board.create(&draft("A"), T0).unwrap();
        let path = dir.path().join(&t.file);
        let text = fs::read_to_string(&path).unwrap();
        let edited = text.replacen("---\n", "---\n# mine\nowner: me\n", 1);
        fs::write(&path, edited).unwrap();
        board
            .update(
                &t.id,
                &TaskPatch {
                    priority: Some(Priority::P0),
                    ..TaskPatch::default()
                },
                None,
                T1,
            )
            .unwrap();
        let after = fs::read_to_string(&path).unwrap();
        assert!(after.starts_with("---\n# mine\nowner: me\nid: "));
        assert!(after.contains("priority: p0\n"));
        assert!(after.contains(&format!("updated: {T1}\n")));
    }

    #[test]
    fn a_stale_update_is_a_conflict_with_the_current_task() {
        let (_dir, board) = setup();
        let t = board.create(&draft("A"), T0).unwrap();
        let first = board
            .update(&t.id, &TaskPatch::default(), Some(T0), T1)
            .unwrap();
        let err = board
            .update(
                &t.id,
                &TaskPatch {
                    title: Some("B".into()),
                    ..TaskPatch::default()
                },
                Some(T0),
                "2026-11-06T11:00:00Z",
            )
            .unwrap_err();
        assert_eq!(
            err,
            BoardError::Conflict {
                current: Box::new(first)
            }
        );
        assert_eq!(board.get(&t.id).unwrap().task.title, "A");
    }

    #[test]
    fn a_bad_id_never_reaches_a_path() {
        let (_dir, board) = setup();
        for id in ["../x", "T1234567", "t12", "t7k2m4q.md", ""] {
            assert_eq!(board.get(id), Err(BoardError::BadId), "{id}");
            assert_eq!(board.delete(id), Err(BoardError::BadId), "{id}");
            assert_eq!(
                board.update(id, &TaskPatch::default(), None, T0),
                Err(BoardError::BadId),
                "{id}"
            );
        }
    }

    #[test]
    fn create_many_is_all_or_nothing() {
        let (dir, board) = setup();
        let err = board
            .create_many(&[draft("one"), draft("  "), draft("three")], T0)
            .unwrap_err();
        assert!(matches!(err, BoardError::Parse(_)));
        assert_eq!(files(dir.path()), Vec::<String>::new());
        let ok = board
            .create_many(&[draft("one"), draft("two")], T0)
            .unwrap();
        assert_eq!(ok.len(), 2);
        assert_ne!(ok[0].id, ok[1].id);
        assert_eq!(board.list().tasks.len(), 2);
        assert_eq!(files(dir.path()).len(), 2);
    }

    #[test]
    fn a_large_or_odd_file_is_unreadable_and_never_rewritten() {
        let (dir, board) = setup();
        let t = board.create(&draft("A"), T0).unwrap();
        let tasks = dir.path().join(".xdev/tasks");
        let big = format!("---\ntitle: big\n---\n{}", "x".repeat(300 * 1024));
        fs::write(tasks.join("tbbbbbb.md"), big).unwrap();
        fs::write(tasks.join("notes.md"), "---\ntitle: n\n---\n").unwrap();
        fs::write(tasks.join("tcccccc.md"), "no front matter").unwrap();
        fs::write(tasks.join("readme.txt"), "x").unwrap();
        let list = board.list();
        assert_eq!(list.tasks.len(), 1);
        assert_eq!(list.tasks[0].id, t.id);
        let files: Vec<&str> = list.unreadable.iter().map(|u| u.file.as_str()).collect();
        assert_eq!(
            files,
            [
                ".xdev/tasks/notes.md",
                ".xdev/tasks/tbbbbbb.md",
                ".xdev/tasks/tcccccc.md"
            ]
        );
        assert_eq!(list.unreadable[1].reason, "larger than 256 KB");
        assert_eq!(board.get("tbbbbbb"), Err(BoardError::TooLarge));
        assert!(matches!(board.get("tcccccc"), Err(BoardError::Parse(_))));
        assert!(
            board
                .update("tcccccc", &TaskPatch::default(), None, T1)
                .is_err()
        );
        assert_eq!(
            fs::read_to_string(tasks.join("tcccccc.md")).unwrap(),
            "no front matter"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_is_skipped() {
        let (dir, board) = setup();
        let t = board.create(&draft("A"), T0).unwrap();
        let tasks = dir.path().join(".xdev/tasks");
        std::os::unix::fs::symlink(tasks.join(format!("{}.md", t.id)), tasks.join("tzzzzzz.md"))
            .unwrap();
        assert_eq!(board.list().tasks.len(), 1);
        assert!(board.list().unreadable.is_empty());
        assert_eq!(board.get("tzzzzzz"), Err(BoardError::NotFound));
    }

    #[test]
    fn crlf_files_keep_their_line_ends_on_update() {
        let (dir, board) = setup();
        let tasks = dir.path().join(".xdev/tasks");
        fs::create_dir_all(&tasks).unwrap();
        fs::write(
            tasks.join("taaaaaa.md"),
            "---\r\nid: taaaaaa\r\ntitle: A\r\nupdated: x\r\n---\r\nbody\r\n",
        )
        .unwrap();
        board
            .update(
                "taaaaaa",
                &TaskPatch {
                    status: Some(TaskStatus::Todo),
                    ..TaskPatch::default()
                },
                None,
                T1,
            )
            .unwrap();
        let text = fs::read_to_string(tasks.join("taaaaaa.md")).unwrap();
        assert_eq!(
            text,
            format!(
                "---\r\nid: taaaaaa\r\ntitle: A\r\nupdated: {T1}\r\nstatus: todo\r\n---\r\nbody\r\n"
            )
        );
    }
}
