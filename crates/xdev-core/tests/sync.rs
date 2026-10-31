use std::fs::{self, File};
use std::path::Path;

use tempfile::TempDir;
use xdev_core::{DocEntry, Skip, Store, Vault, index_path, search, sync_vault};
use xdev_vault::MAX_DOC_BYTES;

fn write(root: &Path, rel: &str, content: &[u8]) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn setup(files: &[(&str, &str)]) -> (TempDir, Vault, Store) {
    let dir = TempDir::new().unwrap();
    for (rel, content) in files {
        write(dir.path(), rel, content.as_bytes());
    }
    let vault = Vault::open(dir.path()).unwrap();
    (dir, vault, Store::open_in_memory().unwrap())
}

fn hit_paths(store: &Store, query: &str) -> Vec<String> {
    search(store, query, 20)
        .unwrap()
        .into_iter()
        .map(|h| h.path)
        .collect()
}

fn entry(path: &str, title: &str, size: u64, skipped: Option<Skip>) -> DocEntry {
    DocEntry {
        path: path.to_owned(),
        title: title.to_owned(),
        size,
        skipped,
    }
}

#[test]
fn first_sync_indexes_all() {
    let (_dir, vault, mut store) =
        setup(&[("b.md", "# Beta\nbody two"), ("a/c.md", "plain words")]);
    let entries = sync_vault(&vault, &mut store).unwrap();
    assert_eq!(
        entries,
        [
            entry("a/c.md", "c", 11, None),
            entry("b.md", "Beta", 15, None)
        ]
    );
    assert_eq!(hit_paths(&store, "two"), ["b.md"]);
    assert_eq!(hit_paths(&store, "plain"), ["a/c.md"]);
    assert_eq!(store.docs().unwrap().len(), 2);
}

#[test]
fn second_sync_reads_nothing_when_unchanged() {
    let (dir, vault, mut store) = setup(&[("a.md", "# Alpha\nfirst")]);
    sync_vault(&vault, &mut store).unwrap();
    let before = store.docs().unwrap();

    // Same size and mtime but new text: only a sync that re-reads the file
    // would notice, so finding the old text proves nothing was read.
    let path = dir.path().join("a.md");
    let mtime = fs::metadata(&path).unwrap().modified().unwrap();
    fs::write(&path, "# Gamma\nsecnd").unwrap();
    File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(mtime)
        .unwrap();

    let entries = sync_vault(&vault, &mut store).unwrap();
    assert_eq!(entries, [entry("a.md", "Alpha", 13, None)]);
    assert_eq!(store.docs().unwrap(), before);
    assert_eq!(hit_paths(&store, "first"), ["a.md"]);
    assert!(hit_paths(&store, "gamma").is_empty());
}

#[test]
fn sync_picks_up_edit_and_delete() {
    let (dir, vault, mut store) = setup(&[("a.md", "# A\nold"), ("b.md", "gone soon")]);
    sync_vault(&vault, &mut store).unwrap();

    write(dir.path(), "a.md", b"# A2\nfresh text");
    fs::remove_file(dir.path().join("b.md")).unwrap();
    let entries = sync_vault(&vault, &mut store).unwrap();

    assert_eq!(entries, [entry("a.md", "A2", 15, None)]);
    assert_eq!(hit_paths(&store, "fresh"), ["a.md"]);
    assert!(hit_paths(&store, "old").is_empty());
    assert!(hit_paths(&store, "gone").is_empty());
    assert_eq!(store.docs().unwrap().len(), 1);
    assert_eq!(store.docs().unwrap()[0].title, "A2");
}

#[test]
fn skipped_files_listed_not_indexed() {
    let (dir, vault, mut store) = setup(&[("ok.md", "# Ok\nfine"), ("bin.md", "# Bin\nhidden")]);
    sync_vault(&vault, &mut store).unwrap();
    assert_eq!(hit_paths(&store, "hidden"), ["bin.md"]);

    // Turns an indexed doc into a skipped one, so its old row must go.
    write(dir.path(), "bin.md", &[0xff, 0xfe, b'x']);
    write(
        dir.path(),
        "big.md",
        &vec![b'a'; MAX_DOC_BYTES as usize + 1],
    );
    let entries = sync_vault(&vault, &mut store).unwrap();

    assert_eq!(
        entries,
        [
            entry("big.md", "big", MAX_DOC_BYTES + 1, Some(Skip::TooLarge)),
            entry("bin.md", "bin", 3, Some(Skip::NotUtf8)),
            entry("ok.md", "Ok", 9, None),
        ]
    );
    assert!(hit_paths(&store, "hidden").is_empty());
    let stored: Vec<_> = store.docs().unwrap().into_iter().map(|d| d.path).collect();
    assert_eq!(stored, ["ok.md"]);
}

/// The desktop UI parses these shapes; see `DocEntry` and `SearchHit` in the spec.
#[test]
fn serializes_like_the_ui_contract() {
    let json = serde_json::to_string(&[
        entry("a.md", "A", 1, None),
        entry("b.md", "b", 2, Some(Skip::TooLarge)),
        entry("c.md", "c", 3, Some(Skip::NotUtf8)),
    ])
    .unwrap();
    assert_eq!(
        json,
        r#"[{"path":"a.md","title":"A","size":1,"skipped":null},{"path":"b.md","title":"b","size":2,"skipped":"too_large"},{"path":"c.md","title":"c","size":3,"skipped":"not_utf8"}]"#
    );
    let hit = xdev_core::SearchHit {
        path: "a.md".into(),
        title: "A".into(),
        snippet: "<mark>a</mark>".into(),
    };
    assert_eq!(
        serde_json::to_string(&hit).unwrap(),
        r#"{"path":"a.md","title":"A","snippet":"<mark>a</mark>"}"#
    );
}

#[test]
fn error_codes_pass_through() {
    let (_dir, vault, _store) = setup(&[]);
    let err = xdev_core::CoreError::from(vault.read("../x.md").unwrap_err());
    assert_eq!(err.code(), "outside_vault");
    let err = xdev_core::CoreError::from(Vault::open("no/such/dir").err().unwrap());
    assert_eq!(err.code(), "not_found");
    let store_err = xdev_store::StoreError::Io(std::io::Error::other("x"));
    assert_eq!(xdev_core::CoreError::from(store_err).code(), "io");
}

#[test]
fn index_path_uses_vault_id() {
    let (_dir, vault, _store) = setup(&[]);
    let data = Path::new("data");
    assert_eq!(
        index_path(data, &vault),
        data.join("vaults").join(vault.id()).join("index.db")
    );
}
