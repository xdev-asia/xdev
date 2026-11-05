use std::fs;

use xdev_kit::HomeSource;

use super::*;

fn claude_home(dir: &Path) -> Home {
    Home {
        id: "own-claude".into(),
        agent: Agent::Claude,
        path: dir.to_path_buf(),
        source: HomeSource::Own,
    }
}

const LINE: &str = "{\"type\":\"user\",\"timestamp\":\"2026-11-02T10:00:00Z\",\"message\":{\"content\":\"hello\"}}\n";

/// A claude home with one log, and its index.
fn fixture() -> (tempfile::TempDir, Home, SessionIndex, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let proj = dir.path().join("projects").join("-work-demo");
    fs::create_dir_all(&proj).unwrap();
    let file = proj.join("s-1.jsonl");
    fs::write(&file, LINE).unwrap();
    let home = claude_home(&fs::canonicalize(dir.path()).unwrap());
    let mut index = SessionIndex::default();
    index.refresh(std::slice::from_ref(&home));
    (dir, home, index, file)
}

fn stores(home: &Home) -> Vec<PathBuf> {
    vec![store_of(home)]
}

#[test]
fn a_log_inside_the_store_is_accepted() {
    let (_d, home, _i, file) = fixture();
    assert!(log_in_store(
        &fs::canonicalize(file).unwrap(),
        &stores(&home)
    ));
}

#[test]
fn a_log_outside_the_store_is_refused() {
    let (d, home, _i, _f) = fixture();
    let other = tempfile::tempdir().unwrap();
    let out = other.path().join("x.jsonl");
    fs::write(&out, LINE).unwrap();
    assert!(!log_in_store(&out, &stores(&home)));
    // The store itself, a folder, a missing file, another extension.
    assert!(!log_in_store(&store_of(&home), &stores(&home)));
    assert!(!log_in_store(
        &d.path().join("projects").join("gone.jsonl"),
        &stores(&home)
    ));
    let txt = d.path().join("projects").join("-work-demo").join("a.txt");
    fs::write(&txt, "x").unwrap();
    assert!(!log_in_store(&txt, &stores(&home)));
}

#[test]
fn dot_dot_is_refused_even_when_it_lands_inside() {
    let (d, home, _i, _f) = fixture();
    let sneaky = d
        .path()
        .join("projects")
        .join("-work-demo")
        .join("..")
        .join("-work-demo")
        .join("s-1.jsonl");
    assert!(sneaky.is_file());
    assert!(!log_in_store(&sneaky, &stores(&home)));
}

#[cfg(unix)]
#[test]
fn a_link_is_refused() {
    use std::os::unix::fs::symlink;
    let (d, home, _i, _f) = fixture();
    let other = tempfile::tempdir().unwrap();
    let target = other.path().join("secret.jsonl");
    fs::write(&target, LINE).unwrap();
    let proj = d.path().join("projects").join("-work-demo");
    // A link to a file outside, and one to a file inside.
    let link = proj.join("link.jsonl");
    symlink(&target, &link).unwrap();
    assert!(!log_in_store(&link, &stores(&home)));
    let inner = proj.join("inner.jsonl");
    symlink(proj.join("s-1.jsonl"), &inner).unwrap();
    assert!(!log_in_store(&inner, &stores(&home)));
    // A linked folder that leads out of the store.
    let dir_link = d.path().join("projects").join("out");
    symlink(other.path(), &dir_link).unwrap();
    assert!(!log_in_store(
        &dir_link.join("secret.jsonl"),
        &stores(&home)
    ));
}

#[test]
fn the_session_log_resolves_by_key_and_tail_reads_it() {
    let (_d, home, index, file) = fixture();
    let (h, path) = session_log(&index, std::slice::from_ref(&home), "own-claude:s-1").unwrap();
    assert_eq!(path, fs::canonicalize(file).unwrap());
    let turns = turns_of(&h, &path, TAIL_TURNS, TURN_CHARS);
    assert_eq!(turns.len(), 1);
    assert_eq!(
        (turns[0].role.as_str(), turns[0].text.as_str()),
        ("user", "hello")
    );
    let e = session_log(&index, &[home], "own-claude:nope").unwrap_err();
    assert_eq!(e.code, "not_found");
}

#[test]
fn a_session_whose_log_left_the_store_is_not_resolved() {
    let (_d, home, mut index, _f) = fixture();
    let other = tempfile::tempdir().unwrap();
    let out = other.path().join("x.jsonl");
    fs::write(&out, LINE).unwrap();
    let mark = index.files.values_mut().next().unwrap();
    let key = mark.session.clone();
    let old = index.files.keys().next().unwrap().clone();
    let mark = index.files.remove(&old).unwrap();
    index.files.insert(out.to_string_lossy().into_owned(), mark);
    let e = session_log(&index, &[home], &key).unwrap_err();
    assert_eq!(e.code, "bad_path");
    assert!(out.exists());
}

#[test]
fn delete_removes_the_log_and_a_refresh_drops_the_session() {
    let (_d, home, mut index, file) = fixture();
    let homes = std::slice::from_ref(&home);
    let removed = remove_log(&index, homes, "own-claude:s-1").unwrap();
    assert!(!file.exists());
    assert_eq!(
        removed,
        fs::canonicalize(file.parent().unwrap())
            .unwrap()
            .join("s-1.jsonl")
    );
    index.refresh(homes);
    assert!(index.list().is_empty());
    assert_eq!(
        remove_log(&index, homes, "own-claude:s-1")
            .unwrap_err()
            .code,
        "not_found"
    );
}

#[test]
fn skipped_paths_are_counted_and_listed_up_to_twenty() {
    let mut index = SessionIndex::default();
    assert_eq!(skipped_of(&index).count, 0);
    index.skipped = (0..25).map(|i| format!("/l/{i}.jsonl")).collect();
    let s = skipped_of(&index);
    assert_eq!(s.count, 25);
    assert_eq!(s.paths.len(), 20);
    assert_eq!(s.paths[0], "/l/0.jsonl");
}

#[test]
fn tail_bounds_fill_defaults_and_clamp() {
    assert_eq!(tail_bounds(None, None), (6, 1_200));
    assert_eq!(tail_bounds(Some(0), Some(0)), (1, 1));
    assert_eq!(tail_bounds(Some(9_999), Some(99_999)), (200, 8_000));
    assert_eq!(tail_bounds(Some(20), Some(500)), (20, 500));
}

#[test]
fn context_usage_of_a_log_has_a_window_or_is_unknown() {
    let (_dir, home, _index, file) = fixture();
    // The user-only log has no usage: unknown, not zero.
    assert_eq!(usage_of(&home, &file), None);
    let usage = "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-sonnet-5-5\",\"usage\":{\"input_tokens\":5,\"cache_read_input_tokens\":45000}}}\n";
    fs::write(&file, format!("{LINE}{usage}")).unwrap();
    let got = usage_of(&home, &file).unwrap();
    assert_eq!((got.tokens, got.window), (45_005.0, 200_000.0));
    assert_eq!(got.model.as_deref(), Some("claude-sonnet-5-5"));
    assert_eq!(usage_of(&home, &file.with_extension("missing")), None);
}
