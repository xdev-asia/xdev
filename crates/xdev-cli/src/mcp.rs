use std::collections::HashMap;
use std::io;

use xdev_core::{
    CoreError, DocState, GitError, Repo, Store, Vault, backlinks, freshness, is_doc_path,
    parse_frontmatter, propose_update, search, stale_docs, sync_vault,
};
use xdev_mcp::{Doc, DocInfo, Docs, Hit, ToolError};

/// Serves the vault on stdin/stdout until the client closes stdin.
pub fn run(vault: Vault, mut store: Store) -> Result<(), &'static str> {
    // Synced before the first request so a client that only calls get_doc
    // still sees titles and backlinks.
    sync_vault(&vault, &mut store).map_err(|e| e.code())?;
    let mut docs = CoreDocs { vault, store };
    xdev_mcp::serve(
        &mut docs,
        io::stdin().lock(),
        io::stdout().lock(),
        xdev_core::version(),
    )
    .map_err(|_| "io")
}

struct CoreDocs {
    vault: Vault,
    store: Store,
}

fn tool_error(e: impl Into<CoreError>) -> ToolError {
    ToolError {
        code: e.into().code().to_owned(),
    }
}

fn state_name(state: DocState) -> &'static str {
    match state {
        DocState::None => "none",
        DocState::Fresh => "fresh",
        DocState::Stale => "stale",
        DocState::Unverified => "unverified",
        DocState::Unknown => "unknown",
    }
}

impl CoreDocs {
    fn sync(&mut self) -> Result<(), ToolError> {
        sync_vault(&self.vault, &mut self.store).map_err(tool_error)?;
        Ok(())
    }

    /// Looked up per call: `git init` while the server runs should count.
    /// Without git, reads still work and covered docs are `unknown`.
    fn repo(&self) -> Result<Option<Repo>, ToolError> {
        match Repo::discover(self.vault.root()) {
            Ok(repo) => Ok(Some(repo)),
            Err(GitError::NoRepo | GitError::NoGit) => Ok(None),
            Err(e) => Err(tool_error(e)),
        }
    }

    fn titles(&self) -> Result<HashMap<String, String>, ToolError> {
        Ok(self
            .store
            .docs()
            .map_err(tool_error)?
            .into_iter()
            .map(|d| (d.path, d.title))
            .collect())
    }

    fn info(&self, repo: Option<&Repo>, path: &str, title: String) -> Result<DocInfo, ToolError> {
        let content = self.vault.read(path).map_err(tool_error)?;
        let fm = parse_frontmatter(&content).0;
        // Docs without `covers` skip git entirely; listing a large vault
        // should not cost a process per doc.
        let (state, count) = if fm.covers.is_empty() {
            (DocState::None, 0)
        } else {
            let f = freshness(&self.vault, repo, path).map_err(tool_error)?;
            (f.state, f.count)
        };
        Ok(DocInfo {
            path: path.to_owned(),
            title,
            doc_type: fm.doc_type,
            state: state_name(state).to_owned(),
            covers: fm.covers,
            count,
        })
    }
}

impl Docs for CoreDocs {
    fn context_pack(
        &mut self,
        query: &str,
        budget: usize,
    ) -> Result<xdev_core::ContextPack, ToolError> {
        self.sync()?;
        crate::context::pack(&self.vault, &self.store, query, budget)
            .map_err(|code| ToolError { code: code.into() })
    }

    fn vault_name(&self) -> String {
        let root = self.vault.root().display().to_string();
        root.trim_start_matches(r"\\?\").to_owned()
    }

    fn search(&mut self, query: &str, limit: usize) -> Result<Vec<Hit>, ToolError> {
        self.sync()?;
        Ok(search(&self.store, query, limit)
            .map_err(tool_error)?
            .into_iter()
            .map(|h| Hit {
                path: h.path,
                title: h.title,
                snippet: h.snippet,
            })
            .collect())
    }

    fn get(&mut self, path: &str) -> Result<Doc, ToolError> {
        // `Vault::read` takes any file inside the vault; agents get docs only.
        if !is_doc_path(path) {
            return Err(ToolError {
                code: "outside_vault".to_owned(),
            });
        }
        self.sync()?;
        let content = self.vault.read(path).map_err(tool_error)?;
        let title = self.titles()?.remove(path).unwrap_or_default();
        let repo = self.repo()?;
        let info = self.info(repo.as_ref(), path, title)?;
        let backlinks = backlinks(&self.vault, &self.store, path)
            .map_err(tool_error)?
            .into_iter()
            .map(|l| l.path)
            .collect();
        Ok(Doc {
            info,
            content,
            backlinks,
        })
    }

    fn list(&mut self, doc_type: Option<&str>) -> Result<Vec<DocInfo>, ToolError> {
        self.sync()?;
        let repo = self.repo()?;
        let mut out = Vec::new();
        for doc in self.store.docs().map_err(tool_error)? {
            // A doc removed since the sync is skipped, as the index will.
            let Ok(info) = self.info(repo.as_ref(), &doc.path, doc.title) else {
                continue;
            };
            if doc_type.is_none_or(|t| info.doc_type.as_deref() == Some(t)) {
                out.push(info);
            }
        }
        Ok(out)
    }

    fn stale(&mut self) -> Result<Vec<DocInfo>, ToolError> {
        self.sync()?;
        let repo = self.repo()?;
        let mut out = Vec::new();
        for doc in stale_docs(&self.vault, repo.as_ref()).map_err(tool_error)? {
            let content = self.vault.read(&doc.path).map_err(tool_error)?;
            let fm = parse_frontmatter(&content).0;
            out.push(DocInfo {
                path: doc.path,
                title: doc.title,
                doc_type: fm.doc_type,
                state: state_name(doc.state).to_owned(),
                covers: fm.covers,
                count: doc.count,
            });
        }
        Ok(out)
    }

    fn propose(
        &mut self,
        path: &str,
        content: &str,
        summary: Option<&str>,
    ) -> Result<(), ToolError> {
        // Without git there is no review to wait in, so nothing is written.
        let repo = Repo::discover(self.vault.root()).map_err(tool_error)?;
        propose_update(&self.vault, &repo, &mut self.store, path, content, summary)
            .map_err(tool_error)?;
        self.sync()
    }
}
