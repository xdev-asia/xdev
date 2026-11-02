use std::collections::HashMap;

use rusqlite::{Transaction, params};

use crate::{Store, StoreError};

pub trait Embedder {
    fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, StoreError>;
    fn model(&self) -> &str;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Section {
    pub ordinal: usize,
    pub heading: String,
    pub text: String,
}

pub fn split_sections(title: &str, body: &str) -> Vec<Section> {
    let mut out = Vec::new();
    let mut headings = vec![title.to_owned()];
    let mut text = String::new();
    let mut fence: Option<char> = None;
    for line in body.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            let marker = trimmed.chars().next().unwrap();
            if fence == Some(marker) {
                fence = None;
            } else if fence.is_none() {
                fence = Some(marker);
            }
        }
        let level = line.chars().take_while(|&c| c == '#').count();
        if fence.is_none() && (1..=3).contains(&level) && line.as_bytes().get(level) == Some(&b' ')
        {
            append_sections(&mut out, &headings.join(" > "), &text);
            text.clear();
            headings.truncate(level - 1);
            if headings.is_empty() && level > 1 {
                headings.push(title.to_owned());
            }
            headings.push(line[level..].trim().trim_end_matches('#').trim().to_owned());
        }
        text.push_str(line);
        text.push('\n');
    }
    append_sections(&mut out, &headings.join(" > "), &text);
    out
}

fn append_sections(out: &mut Vec<Section>, heading: &str, text: &str) {
    let mut pending = String::new();
    for paragraph in text.trim().split("\n\n") {
        let mut remaining = paragraph.trim();
        while !remaining.is_empty() {
            let separator = if pending.is_empty() { "" } else { "\n\n" };
            if pending.chars().count() + separator.len() + remaining.chars().count() <= 1500 {
                pending.push_str(separator);
                pending.push_str(remaining);
                break;
            }
            if !pending.is_empty() {
                out.push(Section {
                    ordinal: out.len(),
                    heading: heading.into(),
                    text: std::mem::take(&mut pending),
                });
            } else {
                let end = remaining
                    .char_indices()
                    .nth(1500)
                    .map_or(remaining.len(), |(i, _)| i);
                out.push(Section {
                    ordinal: out.len(),
                    heading: heading.into(),
                    text: remaining[..end].into(),
                });
                remaining = remaining[end..].trim_start();
            }
        }
    }
    if !pending.is_empty() {
        out.push(Section {
            ordinal: out.len(),
            heading: heading.into(),
            text: pending,
        });
    }
}

pub(crate) fn sync_chunks(
    tx: &Transaction<'_>,
    path: &str,
    title: &str,
    body: &str,
) -> Result<(), StoreError> {
    let sections = split_sections(title, body);
    // Reuse by content rather than ordinal so inserting a heading preserves later vectors.
    let mut stmt = tx.prepare(
        "SELECT hash, model, dim, vector FROM chunks WHERE doc_path = ?1 AND vector IS NOT NULL",
    )?;
    let old = stmt
        .query_map([path], |r| {
            Ok((
                r.get::<_, String>(0)?,
                (
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                    r.get::<_, Option<Vec<u8>>>(3)?,
                ),
            ))
        })?
        .collect::<Result<HashMap<_, _>, _>>()?;
    tx.execute("DELETE FROM chunks WHERE doc_path = ?1", [path])?;
    for section in sections {
        let hash = blake3::hash(section.text.as_bytes()).to_hex().to_string();
        let (model, dim, vector) = old.get(&hash).cloned().unwrap_or_default();
        tx.execute("INSERT INTO chunks (doc_path, ordinal, heading, text, hash, model, dim, vector) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)", params![path, section.ordinal as i64, section.heading, section.text, hash, model, dim, vector])?;
    }
    Ok(())
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct EmbedStats {
    pub embedded: usize,
    pub kept: usize,
    pub removed: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ContextPack {
    pub mode: String,
    pub sections: Vec<ContextSection>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ContextSection {
    pub path: String,
    pub heading: String,
    pub text: String,
    pub score: f64,
    pub stale: bool,
}

struct Chunk {
    path: String,
    ordinal: i64,
    heading: String,
    text: String,
    model: Option<String>,
    vector: Option<Vec<u8>>,
}

impl Store {
    pub fn chunk_count(&self) -> Result<usize, StoreError> {
        Ok(self
            .conn
            .query_row("SELECT count(*) FROM chunks", [], |r| r.get::<_, i64>(0))?
            as usize)
    }

    pub fn embed_vault(&mut self, embedder: &dyn Embedder) -> Result<EmbedStats, StoreError> {
        let mut stats = EmbedStats {
            removed: self.removed_chunks,
            ..EmbedStats::default()
        };
        let mut stmt = self.conn.prepare("SELECT doc_path, ordinal, text, model, vector IS NOT NULL FROM chunks ORDER BY doc_path, ordinal")?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, bool>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);
        let mut pending = Vec::new();
        for (path, ordinal, text, model, has_vector) in rows {
            if has_vector && model.as_deref() == Some(embedder.model()) {
                stats.kept += 1;
            } else {
                pending.push((path, ordinal, text));
            }
        }
        for batch in pending.chunks(32) {
            let texts = batch.iter().map(|row| row.2.as_str()).collect::<Vec<_>>();
            let vectors = embedder.embed(&texts)?;
            if vectors.len() != batch.len()
                || vectors.iter().any(|v| !valid_vector(v))
                || vectors.iter().any(|v| v.len() != vectors[0].len())
            {
                return Err(StoreError::Embedding("invalid_embeddings".into()));
            }
            let tx = self.conn.transaction()?;
            for ((path, ordinal, _), vector) in batch.iter().zip(vectors) {
                let bytes = vector
                    .iter()
                    .flat_map(|v| v.to_le_bytes())
                    .collect::<Vec<_>>();
                tx.execute("UPDATE chunks SET model = ?1, dim = ?2, vector = ?3 WHERE doc_path = ?4 AND ordinal = ?5", params![embedder.model(), vector.len() as i64, bytes, path, ordinal])?;
            }
            tx.commit()?;
            stats.embedded += batch.len();
        }
        self.removed_chunks = 0;
        Ok(stats)
    }

    pub fn context_pack(
        &self,
        query: &str,
        budget: usize,
        embedder: Option<&dyn Embedder>,
    ) -> Result<ContextPack, StoreError> {
        let mut stmt = self.conn.prepare("SELECT doc_path, ordinal, heading, text, model, vector FROM chunks ORDER BY doc_path, ordinal")?;
        let chunks = stmt
            .query_map([], |r| {
                Ok(Chunk {
                    path: r.get(0)?,
                    ordinal: r.get(1)?,
                    heading: r.get(2)?,
                    text: r.get(3)?,
                    model: r.get(4)?,
                    vector: r.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let keyword = self
            .search(query, 20)?
            .into_iter()
            .enumerate()
            .map(|(i, h)| (h.path, i + 1))
            .collect::<HashMap<_, _>>();
        let mut scores = vec![0.0; chunks.len()];
        for (i, chunk) in chunks.iter().enumerate() {
            if let Some(rank) = keyword.get(&chunk.path) {
                scores[i] = 1.0 / (60 + rank) as f64;
            }
        }
        let mut mode = "keyword";
        if let Some(embedder) = embedder {
            let matching = chunks
                .iter()
                .any(|c| c.model.as_deref() == Some(embedder.model()) && c.vector.is_some());
            if matching
                && let Ok(vectors) = embedder.embed(&[query])
                && vectors.len() == 1
                && valid_vector(&vectors[0])
            {
                let mut ranked = Vec::new();
                for (i, chunk) in chunks.iter().enumerate() {
                    if chunk.model.as_deref() != Some(embedder.model()) {
                        continue;
                    }
                    if let Some(bytes) = &chunk.vector {
                        let vector = bytes
                            .chunks_exact(4)
                            .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
                            .collect::<Vec<_>>();
                        if bytes.len() % 4 == 0
                            && vector.len() == vectors[0].len()
                            && valid_vector(&vector)
                        {
                            ranked.push((i, cosine(&vectors[0], &vector)));
                        }
                    }
                }
                ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
                if !ranked.is_empty() {
                    mode = "hybrid";
                }
                for (rank, (i, _)) in ranked.into_iter().enumerate() {
                    scores[i] += 1.0 / (61 + rank) as f64;
                }
            }
        }
        let mut order = (0..chunks.len())
            .filter(|&i| scores[i] > 0.0)
            .collect::<Vec<_>>();
        order.sort_by(|&a, &b| {
            scores[b]
                .total_cmp(&scores[a])
                .then(chunks[a].path.cmp(&chunks[b].path))
                .then(chunks[a].ordinal.cmp(&chunks[b].ordinal))
        });
        let mut sections = Vec::new();
        let mut remaining = budget;
        for i in order {
            let c = &chunks[i];
            let size = c.text.chars().count();
            if size > remaining {
                continue;
            }
            remaining -= size;
            sections.push(ContextSection {
                path: c.path.clone(),
                heading: c.heading.clone(),
                text: c.text.clone(),
                score: scores[i],
                stale: false,
            });
        }
        Ok(ContextPack {
            mode: mode.into(),
            sections,
        })
    }
}

fn valid_vector(v: &[f32]) -> bool {
    !v.is_empty() && v.iter().all(|x| x.is_finite()) && v.iter().any(|&x| x != 0.0)
}

fn cosine(a: &[f32], b: &[f32]) -> f64 {
    let dot = a
        .iter()
        .zip(b)
        .map(|(&a, &b)| f64::from(a) * f64::from(b))
        .sum::<f64>();
    let norm = |v: &[f32]| v.iter().map(|&x| f64::from(x).powi(2)).sum::<f64>().sqrt();
    dot / (norm(a) * norm(b))
}

pub(crate) fn backfill_chunks(conn: &mut rusqlite::Connection) -> Result<(), StoreError> {
    let tx = conn.transaction()?;
    let rows = {
        let mut stmt = tx.prepare("SELECT d.path, d.title, f.body_raw FROM docs d JOIN docs_fts f ON f.rowid = d.id WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.doc_path = d.path)")?;
        stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?
    };
    for (path, title, body) in rows {
        sync_chunks(&tx, &path, &title, &body)?;
    }
    tx.commit()?;
    Ok(())
}
