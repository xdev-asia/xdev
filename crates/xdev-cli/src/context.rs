use xdev_ai::ollama::Ollama;
use xdev_core::{ContextPack, Embedder, GitError, Repo, Store, StoreError, Vault, stale_docs};

pub struct OllamaEmbedder {
    client: Ollama,
    model: String,
}

impl OllamaEmbedder {
    pub fn new(model: Option<String>) -> Self {
        Self {
            client: Ollama::default(),
            model: model
                .or_else(|| std::env::var("XDEV_EMBED_MODEL").ok())
                .unwrap_or_else(|| "nomic-embed-text".into()),
        }
    }
}

impl Embedder for OllamaEmbedder {
    fn model(&self) -> &str {
        &self.model
    }

    fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, StoreError> {
        self.client
            .embed(&self.model, texts)
            .map_err(|e| StoreError::Embedding(e.code().into()))
    }
}

pub fn error_code(error: StoreError) -> &'static str {
    match error {
        StoreError::Embedding(code) if code == "ollama_unreachable" => "ollama_unreachable",
        StoreError::Embedding(_) => "ollama_error",
        _ => "io",
    }
}

pub fn pack(
    vault: &Vault,
    store: &Store,
    query: &str,
    budget: usize,
) -> Result<ContextPack, &'static str> {
    let mut pack = store
        .context_pack(query, budget, Some(&OllamaEmbedder::new(None)))
        .map_err(error_code)?;
    let repo = match Repo::discover(vault.root()) {
        Ok(repo) => Some(repo),
        Err(GitError::NoRepo | GitError::NoGit) => None,
        Err(e) => return Err(e.code()),
    };
    let stale = stale_docs(vault, repo.as_ref()).map_err(|e| e.code())?;
    for section in &mut pack.sections {
        section.stale = stale.iter().any(|doc| doc.path == section.path);
    }
    Ok(pack)
}

pub fn markdown(pack: &ContextPack) -> String {
    let mut text = String::new();
    for section in &pack.sections {
        text.push_str(&format!(
            "## {} \u{2014} {}\n{}\n\n",
            section.path, section.heading, section.text
        ));
    }
    text
}
