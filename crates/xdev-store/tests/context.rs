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
    let text = format!("{}\n\n{}", "?".repeat(1000), "z".repeat(1600));
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
