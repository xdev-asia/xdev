use std::cell::Cell;
use xdev_store::{Embedder, Store, StoreError, StoredDoc, split_sections};

struct Fake {
    calls: Cell<usize>,
    model: &'static str,
    fail: bool,
}
impl Embedder for Fake {
    fn model(&self) -> &str {
        self.model
    }
    fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, StoreError> {
        self.calls.set(self.calls.get() + texts.len());
        if self.fail {
            return Err(StoreError::Embedding("offline".into()));
        }
        Ok(texts
            .iter()
            .map(|t| {
                if t.contains("semantic") {
                    vec![1.0, 0.0]
                } else {
                    vec![0.0, 1.0]
                }
            })
            .collect())
    }
}
fn fake(model: &'static str) -> Fake {
    Fake {
        calls: Cell::new(0),
        model,
        fail: false,
    }
}
fn put(store: &mut Store, path: &str, text: &str) {
    store
        .upsert(
            &StoredDoc {
                path: path.into(),
                title: "Doc".into(),
                hash: text.into(),
                size: text.len() as u64,
                mtime_ms: 0,
            },
            text,
            &[],
        )
        .unwrap();
}
#[test]
fn headings_paragraphs_and_unicode_limits() {
    let sections = split_sections(
        "Doc",
        "# Title\nintro\n## Two\nbody\n### Three\nmore\n#### Four\nstill here",
    );
    assert_eq!(sections.len(), 3);
    assert_eq!(sections[2].heading, "Title > Two > Three");
    assert!(sections[2].text.contains("#### Four"));
    let text = format!("{}\n\n{}", "\u{e9}".repeat(1000), "z".repeat(1600));
    let sections = split_sections("Doc", &text);
    assert_eq!(
        sections
            .iter()
            .map(|s| s.text.chars().count())
            .collect::<Vec<_>>(),
        [1000, 1500, 100]
    );
    assert_eq!(sections[2].ordinal, 2);
    assert!(sections.iter().all(|s| s.heading == "Doc"));
}
#[test]
fn incremental_embedding_and_model_changes() {
    let mut store = Store::open_in_memory().unwrap();
    put(&mut store, "a.md", "# Doc\none\n## Two\ntwo");
    let embedder = fake("a");
    assert_eq!(store.embed_vault(&embedder).unwrap().embedded, 2);
    assert_eq!(store.embed_vault(&embedder).unwrap().embedded, 0);
    put(&mut store, "a.md", "# Doc\nchanged\n## Two\ntwo");
    let stats = store.embed_vault(&embedder).unwrap();
    assert_eq!((stats.embedded, stats.kept), (1, 1));
    assert_eq!(store.embed_vault(&fake("b")).unwrap().embedded, 2);
    store.delete("a.md").unwrap();
    assert_eq!(store.chunk_count().unwrap(), 0);
    assert_eq!(store.embed_vault(&embedder).unwrap().removed, 2);
}
#[test]
fn hybrid_keyword_budget_and_failure() {
    let mut store = Store::open_in_memory().unwrap();
    put(&mut store, "a.md", "keyword unrelated");
    put(&mut store, "b.md", "semantic meaning");
    let embedder = fake("a");
    store.embed_vault(&embedder).unwrap();
    let pack = store
        .context_pack("semantic keyword", 8000, Some(&embedder))
        .unwrap();
    assert_eq!(pack.mode, "hybrid");
    assert_eq!(pack.sections[0].path, "b.md");
    let pack = store.context_pack("keyword", 8000, None).unwrap();
    assert_eq!(pack.mode, "keyword");
    assert_eq!(pack.sections.len(), 1);
    assert!(
        store
            .context_pack("keyword", 1, None)
            .unwrap()
            .sections
            .is_empty()
    );
    let offline = Fake {
        fail: true,
        ..fake("a")
    };
    assert_eq!(
        store
            .context_pack("keyword", 8000, Some(&offline))
            .unwrap()
            .mode,
        "keyword"
    );
    assert_eq!(
        store
            .context_pack("keyword", 8000, Some(&fake("other")))
            .unwrap()
            .mode,
        "keyword"
    );
    put(&mut store, "c.md", "new");
    assert!(store.embed_vault(&offline).is_err());
    assert_eq!(store.embed_vault(&embedder).unwrap().embedded, 1);
}

#[test]
fn inserting_and_removing_sections_reuses_shifted_vectors() {
    let mut store = Store::open_in_memory().unwrap();
    let embedder = fake("a");
    put(&mut store, "a.md", "# Title\nfirst\n## Last\nlast");
    store.embed_vault(&embedder).unwrap();
    put(
        &mut store,
        "a.md",
        "# Title\nfirst\n## Inserted\nnew\n## Last\nlast",
    );
    let stats = store.embed_vault(&embedder).unwrap();
    assert_eq!((stats.embedded, stats.kept), (1, 2));
    put(&mut store, "a.md", "# Title\nfirst\n## Last\nlast");
    let stats = store.embed_vault(&embedder).unwrap();
    assert_eq!((stats.embedded, stats.kept, stats.removed), (0, 2, 1));
}

#[test]
fn failed_batch_is_atomic_and_prior_batches_are_reusable() {
    struct Batches(Cell<usize>);
    impl Embedder for Batches {
        fn model(&self) -> &str {
            "a"
        }
        fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, StoreError> {
            self.0.set(self.0.get() + 1);
            assert!(texts.len() <= 32);
            if self.0.get() == 2 {
                return Ok(vec![vec![f32::NAN]; texts.len()]);
            }
            Ok(vec![vec![1.0, 0.0]; texts.len()])
        }
    }
    let mut store = Store::open_in_memory().unwrap();
    let text = (0..34)
        .map(|i| format!("## Heading {i}\nsection {i}\n"))
        .collect::<String>();
    put(&mut store, "a.md", &text);
    assert!(store.embed_vault(&Batches(Cell::new(0))).is_err());
    let stats = store.embed_vault(&fake("a")).unwrap();
    assert_eq!((stats.embedded, stats.kept), (2, 32));
}

#[test]
fn frontmatter_and_fenced_headings_do_not_create_sections() {
    let sections = split_sections(
        "Doc",
        "---\ntitle: Doc\n---\n# Doc\n```md\n## Example\n```\n## Actual\ntext",
    );
    assert_eq!(sections.len(), 2);
    assert_eq!(sections[0].heading, "Doc");
    assert!(!sections[0].text.contains("title:"));
    assert!(sections[0].text.contains("## Example"));
    assert_eq!(sections[1].heading, "Doc > Actual");
}

#[test]
fn reciprocal_rank_fuses_doc_keyword_and_section_cosine_ranks() {
    struct Ranked;
    impl Embedder for Ranked {
        fn model(&self) -> &str {
            "ranked"
        }
        fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, StoreError> {
            Ok(texts
                .iter()
                .map(|t| {
                    if *t == "question unrelated" {
                        vec![0.0, 1.0]
                    } else {
                        vec![1.0, 0.0]
                    }
                })
                .collect())
        }
    }
    let mut store = Store::open_in_memory().unwrap();
    put(&mut store, "a.md", "question unrelated");
    put(&mut store, "b.md", "related explanation");
    store.embed_vault(&Ranked).unwrap();
    let keyword = store.context_pack("question", 8000, None).unwrap();
    let hybrid = store.context_pack("question", 8000, Some(&Ranked)).unwrap();
    assert_eq!(keyword.sections.len(), 1);
    assert_eq!(hybrid.sections.len(), 2);
    assert_eq!(hybrid.sections[0].path, "a.md");
    assert!((hybrid.sections[0].score - (1.0 / 61.0 + 1.0 / 62.0)).abs() < 1e-12);
    assert!((hybrid.sections[1].score - 1.0 / 61.0).abs() < 1e-12);
    let small = store.context_pack("question", 18, Some(&Ranked)).unwrap();
    assert_eq!(small.sections.len(), 1);
    assert_eq!(small.sections[0].text, "question unrelated");
    assert!(
        small
            .sections
            .iter()
            .map(|s| s.text.chars().count())
            .sum::<usize>()
            <= 18
    );
}

#[test]
fn old_index_backfills_sections_without_losing_docs() {
    let temp = tempfile::TempDir::new().unwrap();
    let path = temp.path().join("index.db");
    {
        let mut store = Store::open(&path).unwrap();
        put(&mut store, "a.md", "# Title\nfirst\n## Last\nlast");
    }
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("DROP TABLE chunks; PRAGMA user_version = 4;")
        .unwrap();
    drop(conn);
    let mut store = Store::open(&path).unwrap();
    assert_eq!(store.docs().unwrap().len(), 1);
    assert_eq!(store.chunk_count().unwrap(), 2);
    assert_eq!(store.embed_vault(&fake("a")).unwrap().embedded, 2);
    assert_eq!(
        store.context_pack("last", 8000, None).unwrap().sections[1].heading,
        "Title > Last"
    );
}
