use std::collections::{BTreeSet, HashMap};

use xdev_store::Store;
use xdev_vault::{Link, LinkKind, Resolver, Vault};

use crate::CoreError;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct DocLink {
    pub path: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrokenLink {
    pub from: String,
    /// As the doc wrote it.
    pub target: String,
}

/// Every stored link with the vault path it resolves to, in stored order.
/// Resolution uses the listed files, not the index, so a doc too large to
/// index is still a valid target.
fn resolved_links(
    vault: &Vault,
    store: &Store,
) -> Result<Vec<(String, Link, Option<String>)>, CoreError> {
    let resolver = Resolver::new(vault.list()?.into_iter().map(|m| m.path));
    let mut out = Vec::new();
    for (from, stored) in store.links()? {
        // Rows from a newer build with kinds this one does not know.
        let Some(kind) = LinkKind::parse(&stored.kind) else {
            continue;
        };
        let link = Link {
            kind,
            target: stored.target,
        };
        let to = resolver.resolve(&link, &from);
        out.push((from, link, to));
    }
    Ok(out)
}

/// Docs that link to `path`, each once, sorted by path; a doc linking to
/// itself is left out.
pub fn backlinks(vault: &Vault, store: &Store, path: &str) -> Result<Vec<DocLink>, CoreError> {
    let sources: BTreeSet<String> = resolved_links(vault, store)?
        .into_iter()
        .filter(|(from, _, to)| to.as_deref() == Some(path) && from != path)
        .map(|(from, _, _)| from)
        .collect();
    if sources.is_empty() {
        return Ok(Vec::new());
    }
    let titles: HashMap<String, String> = store
        .docs()?
        .into_iter()
        .map(|d| (d.path, d.title))
        .collect();
    Ok(sources
        .into_iter()
        .map(|from| DocLink {
            title: titles.get(&from).cloned().unwrap_or_default(),
            path: from,
        })
        .collect())
}

/// Sorted by source path, then by position in the doc.
pub fn broken_links(vault: &Vault, store: &Store) -> Result<Vec<BrokenLink>, CoreError> {
    Ok(resolved_links(vault, store)?
        .into_iter()
        .filter(|(_, _, to)| to.is_none())
        .map(|(from, link, _)| BrokenLink {
            from,
            target: link.target,
        })
        .collect())
}
