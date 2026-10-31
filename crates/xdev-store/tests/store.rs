use tempfile::TempDir;
use xdev_store::{Store, StoredDoc, fts_query};

fn doc(path: &str, title: &str, hash: &str) -> StoredDoc {
    StoredDoc {
        path: path.to_owned(),
        title: title.to_owned(),
        hash: hash.to_owned(),
        size: 10,
        mtime_ms: 1_000,
    }
}

fn hit_paths(store: &Store, query: &str) -> Vec<String> {
    store
        .search(query, 20)
        .unwrap()
        .into_iter()
        .map(|h| h.path)
        .collect()
}

#[test]
fn upsert_then_search_finds_doc() {
    let mut store = Store::open_in_memory().unwrap();
    store
        .upsert(&doc("a.md", "Alpha", "h1"), "the quick brown fox")
        .unwrap();
    store
        .upsert(&doc("b.md", "Beta", "h2"), "lazy dog")
        .unwrap();
    let hits = store.search("quick", 20).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].path, "a.md");
    assert_eq!(hits[0].title, "Alpha");
    assert!(
        hits[0].snippet.contains("<mark>quick</mark>"),
        "{}",
        hits[0].snippet
    );
    // Title-only hits fall back to a title snippet.
    let hits = store.search("beta", 20).unwrap();
    assert_eq!(hits[0].snippet, "<mark>Beta</mark>");
    assert_eq!(
        store.docs().unwrap(),
        [doc("a.md", "Alpha", "h1"), doc("b.md", "Beta", "h2")]
    );
}

#[test]
fn upsert_replaces_previous_body() {
    let mut store = Store::open_in_memory().unwrap();
    store.upsert(&doc("a.md", "A", "h1"), "old words").unwrap();
    store.upsert(&doc("a.md", "A", "h2"), "new words").unwrap();
    assert!(hit_paths(&store, "old").is_empty());
    assert_eq!(hit_paths(&store, "new"), ["a.md"]);
    assert_eq!(store.docs().unwrap().len(), 1);
    assert_eq!(store.docs().unwrap()[0].hash, "h2");
}

#[test]
fn upsert_with_same_hash_updates_metadata() {
    let mut store = Store::open_in_memory().unwrap();
    store.upsert(&doc("a.md", "A", "h1"), "body").unwrap();
    let mut moved = doc("a.md", "A", "h1");
    moved.mtime_ms = 2_000;
    store.upsert(&moved, "body").unwrap();
    assert_eq!(store.docs().unwrap(), [moved]);
    assert_eq!(hit_paths(&store, "body"), ["a.md"]);
}

#[test]
fn delete_removes_from_search() {
    let mut store = Store::open_in_memory().unwrap();
    store.upsert(&doc("a.md", "A", "h1"), "needle").unwrap();
    store.delete("a.md").unwrap();
    store.delete("missing.md").unwrap();
    assert!(hit_paths(&store, "needle").is_empty());
    assert!(store.docs().unwrap().is_empty());
}

#[test]
fn search_ignores_diacritics() {
    let mut store = Store::open_in_memory().unwrap();
    store
        .upsert(&doc("vi.md", "Tài liệu", "h"), "Kiến trúc hệ thống")
        .unwrap();
    assert_eq!(hit_paths(&store, "tai lieu"), ["vi.md"]);
    assert_eq!(hit_paths(&store, "KIEN TRUC"), ["vi.md"]);
    assert_eq!(hit_paths(&store, "kiến"), ["vi.md"]);
}

#[test]
fn search_is_prefix_match() {
    let mut store = Store::open_in_memory().unwrap();
    store
        .upsert(&doc("a.md", "A", "h"), "software architecture notes")
        .unwrap();
    assert_eq!(hit_paths(&store, "arch"), ["a.md"]);
    // Terms are combined with AND.
    assert_eq!(hit_paths(&store, "arch soft"), ["a.md"]);
    assert!(hit_paths(&store, "arch missing").is_empty());
}

#[test]
fn search_orders_by_relevance() {
    let mut store = Store::open_in_memory().unwrap();
    store
        .upsert(
            &doc("weak.md", "W", "h1"),
            "rust and many other words here to dilute",
        )
        .unwrap();
    store
        .upsert(&doc("strong.md", "Rust", "h2"), "rust rust rust")
        .unwrap();
    assert_eq!(hit_paths(&store, "rust"), ["strong.md", "weak.md"]);
    assert_eq!(store.search("rust", 1).unwrap().len(), 1);
}

#[test]
fn search_survives_fts_syntax() {
    let mut store = Store::open_in_memory().unwrap();
    store
        .upsert(&doc("a.md", "A", "h"), "foo bar AND near x")
        .unwrap();
    for q in [
        "\"", "AND", "foo*bar", "-x", "NEAR(", "", "   ", "a:b", "(", "*", "^x", "'",
    ] {
        assert!(store.search(q, 20).is_ok(), "query {q:?} failed");
    }
    assert!(store.search("", 20).unwrap().is_empty());
}

#[test]
fn snippet_is_html_escaped() {
    let mut store = Store::open_in_memory().unwrap();
    store
        .upsert(
            &doc("x.md", "X", "h"),
            "<img onerror=x> kiến trúc & \"quotes\" 'single'",
        )
        .unwrap();
    let hits = store.search("kien", 20).unwrap();
    let snippet = &hits[0].snippet;
    assert!(snippet.contains("&lt;img"), "{snippet}");
    assert!(snippet.contains("<mark>kiến</mark>"), "{snippet}");
    assert!(
        snippet.contains("&amp; &quot;quotes&quot; &#39;single&#39;"),
        "{snippet}"
    );
    assert!(!snippet.contains("<img"), "{snippet}");
}

#[test]
fn reopen_keeps_data() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("nested/vault/index.db");
    {
        let mut store = Store::open(&path).unwrap();
        store.upsert(&doc("a.md", "A", "h"), "persisted").unwrap();
    }
    let store = Store::open(&path).unwrap();
    assert_eq!(hit_paths(&store, "persisted"), ["a.md"]);
    assert_eq!(store.docs().unwrap().len(), 1);
}

#[test]
fn fts_query_quotes_terms() {
    assert_eq!(fts_query("a \"b").as_deref(), Some("\"a\"* \"\"\"b\"*"));
    assert_eq!(
        fts_query("  one   two ").as_deref(),
        Some("\"one\"* \"two\"*")
    );
    assert_eq!(fts_query(""), None);
    assert_eq!(fts_query(" \t\n"), None);
}
