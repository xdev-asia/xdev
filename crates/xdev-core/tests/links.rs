use std::fs;

use tempfile::TempDir;
use xdev_core::{BrokenLink, DocLink, Store, Vault, backlinks, broken_links, sync_vault};

fn setup(files: &[(&str, &str)]) -> (TempDir, Vault, Store) {
    let dir = TempDir::new().unwrap();
    for (rel, content) in files {
        let path = dir.path().join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
    let vault = Vault::open(dir.path()).unwrap();
    let mut store = Store::open_in_memory().unwrap();
    sync_vault(&vault, &mut store).unwrap();
    (dir, vault, store)
}

fn doc_link(path: &str, title: &str) -> DocLink {
    DocLink {
        path: path.to_owned(),
        title: title.to_owned(),
    }
}

#[test]
fn backlinks_unique_sorted_without_self() {
    let (_dir, vault, store) = setup(&[
        ("b.md", "# Bee\n[c](c.md)"),
        ("a.md", "[[c]] [[c]]"),
        ("c.md", "[[c]]"),
    ]);
    assert_eq!(
        backlinks(&vault, &store, "c.md").unwrap(),
        [doc_link("a.md", "a"), doc_link("b.md", "Bee")]
    );
    assert!(backlinks(&vault, &store, "a.md").unwrap().is_empty());
}

#[test]
fn broken_links_lists_unresolved() {
    let (_dir, vault, store) = setup(&[("a.md", "[[nope]] [x](gone.md) [[b]]"), ("b.md", "[[a]]")]);
    assert_eq!(
        broken_links(&vault, &store).unwrap(),
        [
            BrokenLink {
                from: "a.md".into(),
                target: "nope".into()
            },
            BrokenLink {
                from: "a.md".into(),
                target: "gone.md".into()
            },
        ]
    );
}

/// A doc too large to index is still a file in the vault, so links to it hold.
#[test]
fn link_to_skipped_doc_is_not_broken() {
    let big = "x".repeat(xdev_vault::MAX_DOC_BYTES as usize + 1);
    let (_dir, vault, store) = setup(&[("a.md", "[[big]]"), ("big.md", &big)]);
    assert!(broken_links(&vault, &store).unwrap().is_empty());
}

#[test]
fn title_from_frontmatter_after_sync() {
    let (_dir, vault, mut store) = setup(&[]);
    fs::write(vault.root().join("t.md"), "---\ntitle: T\n---\n# H").unwrap();
    let entries = sync_vault(&vault, &mut store).unwrap();
    assert_eq!(entries[0].title, "T");
}
