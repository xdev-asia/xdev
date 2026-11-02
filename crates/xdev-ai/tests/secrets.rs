use xdev_ai::secrets::{Keychain, MemoryStore, SecretStore};

#[test]
fn memory_lifecycle_and_redaction() {
    let mut store = MemoryStore::default();
    assert!(store.list().unwrap().iter().all(|(_, set)| !set));
    store.set("openai", "test-placeholder").unwrap();
    let secret = store.get("openai").unwrap().unwrap();
    assert_eq!(format!("{secret:?}"), "***");
    assert!(secret.expose() == "test-placeholder");
    store.set("openai", "replacement-placeholder").unwrap();
    assert!(store.get("openai").unwrap().unwrap().expose() == "replacement-placeholder");
    assert_eq!(
        store.list().unwrap(),
        vec![
            ("anthropic".into(), false),
            ("openai".into(), true),
            ("gemini".into(), false)
        ]
    );
    assert!(store.remove("openai").unwrap());
    assert!(!store.remove("openai").unwrap());
    assert!(store.get("openai").unwrap().is_none());
}

#[test]
fn unknown_provider_is_rejected_before_storage() {
    let mut store = MemoryStore::default();
    assert_eq!(
        store.set("other", "placeholder").unwrap_err().code(),
        "unknown_provider"
    );
    assert_eq!(store.get("other").unwrap_err().code(), "unknown_provider");
    assert_eq!(
        store.remove("other").unwrap_err().code(),
        "unknown_provider"
    );
    assert_eq!(
        Keychain.get("other").unwrap_err().code(),
        "unknown_provider"
    );
}

#[test]
#[ignore = "requires the person's OS keychain"]
fn real_keychain_probe() {
    Keychain.list().unwrap();
}
