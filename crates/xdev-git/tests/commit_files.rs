mod common;

use std::fs;

use common::{Fixture, commit_file, git};
use xdev_git::{CommitFileStatus, GitError};

fn find<'a>(files: &'a [xdev_git::CommitFile], path: &str) -> &'a xdev_git::CommitFile {
    files
        .iter()
        .find(|f| f.path == path)
        .unwrap_or_else(|| panic!("{path} in {files:?}"))
}

#[test]
fn added_modified_and_deleted() {
    let fx = Fixture::new();
    let w = fx.w();
    commit_file(w, "b.txt", "1\n2\n");
    let before = fx.head();
    fs::write(w.join("a.txt"), "a\nmore\n").unwrap();
    fs::remove_file(w.join("b.txt")).unwrap();
    fs::write(w.join("c.txt"), "c\n").unwrap();
    git(w, &["add", "-A"]);
    git(w, &["commit", "-q", "-m", "mix"]);
    let got = fx.repo.commit_files(&fx.head()).unwrap();
    assert_eq!(got.parent.as_deref(), Some(before.as_str()));
    assert_eq!(got.id, fx.head());
    let a = find(&got.files, "a.txt");
    assert_eq!(
        (a.status, a.added, a.removed),
        (CommitFileStatus::Modified, Some(1), Some(0))
    );
    let b = find(&got.files, "b.txt");
    assert_eq!(
        (b.status, b.added, b.removed),
        (CommitFileStatus::Deleted, Some(0), Some(2))
    );
    let c = find(&got.files, "c.txt");
    assert_eq!(
        (c.status, c.added, c.removed),
        (CommitFileStatus::Added, Some(1), Some(0))
    );
}

#[test]
fn a_rename_keeps_the_old_path() {
    let fx = Fixture::new();
    let w = fx.w();
    commit_file(w, "old.txt", "one\ntwo\nthree\nfour\n");
    git(w, &["mv", "old.txt", "new.txt"]);
    git(w, &["commit", "-q", "-m", "rename"]);
    let got = fx.repo.commit_files(&fx.head()).unwrap();
    assert_eq!(got.files.len(), 1);
    let f = &got.files[0];
    assert_eq!(f.status, CommitFileStatus::Renamed);
    assert_eq!(f.path, "new.txt");
    assert_eq!(f.old_path.as_deref(), Some("old.txt"));
    assert_eq!((f.added, f.removed), (Some(0), Some(0)));
}

#[test]
fn a_copy_names_its_source() {
    let fx = Fixture::new();
    let w = fx.w();
    let body = "line one\nline two\nline three\nline four\nline five\n";
    commit_file(w, "src.txt", body);
    fs::write(w.join("src.txt"), format!("{body}extra\n")).unwrap();
    fs::write(w.join("dup.txt"), body).unwrap();
    git(w, &["add", "-A"]);
    git(w, &["commit", "-q", "-m", "copy"]);
    let got = fx.repo.commit_files(&fx.head()).unwrap();
    let dup = find(&got.files, "dup.txt");
    assert_eq!(dup.status, CommitFileStatus::Copied);
    assert_eq!(dup.old_path.as_deref(), Some("src.txt"));
}

#[test]
fn a_binary_file_has_no_counts() {
    let fx = Fixture::new();
    let w = fx.w();
    fs::write(w.join("img.bin"), [0u8, 159, 146, 150, 0, 1, 2]).unwrap();
    git(w, &["add", "-A"]);
    git(w, &["commit", "-q", "-m", "bin"]);
    let got = fx.repo.commit_files(&fx.head()).unwrap();
    let f = find(&got.files, "img.bin");
    assert_eq!(f.status, CommitFileStatus::Added);
    assert_eq!((f.added, f.removed), (None, None));
}

#[test]
fn a_root_commit_has_no_parent() {
    let fx = Fixture::new();
    let w = fx.w();
    let root = git(w, &["rev-list", "--max-parents=0", "HEAD"]);
    let got = fx.repo.commit_files(&root).unwrap();
    assert_eq!(got.parent, None);
    assert_eq!(fx.repo.first_parent(&root).unwrap(), None);
    let f = find(&got.files, "a.txt");
    assert_eq!(f.status, CommitFileStatus::Added);
    assert_eq!(f.added, Some(1));
}

#[test]
fn a_merge_is_diffed_against_its_first_parent() {
    let fx = Fixture::new();
    let w = fx.w();
    git(w, &["switch", "-q", "-c", "side"]);
    commit_file(w, "s.txt", "s\n");
    git(w, &["switch", "-q", "feat"]);
    let feat = commit_file(w, "f.txt", "f\n");
    git(w, &["merge", "-q", "--no-ff", "-m", "merge", "side"]);
    let got = fx.repo.commit_files(&fx.head()).unwrap();
    assert_eq!(got.parent.as_deref(), Some(feat.as_str()));
    assert_eq!(got.files.len(), 1);
    assert_eq!(got.files[0].path, "s.txt");
}

#[test]
fn a_bad_id_is_refused_before_git_sees_it() {
    let fx = Fixture::new();
    for bad in ["--output=x", "HEAD", "", "zz"] {
        assert!(
            matches!(fx.repo.commit_files(bad), Err(GitError::BadId(_))),
            "{bad:?}"
        );
        assert!(matches!(fx.repo.first_parent(bad), Err(GitError::BadId(_))));
    }
}

#[test]
fn spaces_and_non_ascii_names_come_back_verbatim() {
    let fx = Fixture::new();
    let w = fx.w();
    commit_file(w, "my file.txt", "x\n");
    commit_file(w, "tài liệu.md", "y\n");
    let got = fx.repo.commit_files(&fx.head()).unwrap();
    assert_eq!(got.files[0].path, "tài liệu.md");
    let got = fx
        .repo
        .commit_files(&git(w, &["rev-parse", "HEAD~1"]))
        .unwrap();
    assert_eq!(got.files[0].path, "my file.txt");
}
