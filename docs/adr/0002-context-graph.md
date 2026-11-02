# 0002. Context graph in SQLite, files as the source

Status: accepted. Code: grows from `xdev-store`.
Date: 2026-11-02

## Context

Agents need the right slice of a project: the docs, decisions and code a task
touches, and how they link. A separate graph database would add a server and
a second source of truth.

## Decision

- Markdown files and git stay the source of truth. The graph is an index in
  the same SQLite file as search, rebuilt from files at any time.
- Nodes are the core objects (doc, decision, requirement, task, code path).
  Edges come from frontmatter (`covers`, links), wiki links and task records.
- Every edge carries provenance: source file, commit, and how it was derived
  (`frontmatter`, `link`, `task`, `ai`). Edges derived by AI are marked so and
  never overwrite ones a person wrote.
- Embeddings (via Ollama) live beside chunks with a content hash; only
  changed chunks are re-embedded. Brute-force search is enough until about
  100k chunks.
- A "context pack" for a task is a query over this index, built by a future
  `xdev-context` crate once a feature needs it.

## Consequences

- No graph DB, no server; the index can be deleted and rebuilt.
- Graph queries are SQL with recursive CTEs; if that gets slow the index
  layout changes, not the source.
