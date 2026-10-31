//! Wiki and Markdown links between docs. A hand-written scanner, not a
//! CommonMark parser: it only needs to find link targets and stay out of code.

use std::collections::HashMap;

use crate::frontmatter::parse_frontmatter;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkKind {
    Wiki,
    Md,
}

impl LinkKind {
    pub fn as_str(self) -> &'static str {
        match self {
            LinkKind::Wiki => "wiki",
            LinkKind::Md => "md",
        }
    }

    pub fn parse(s: &str) -> Option<LinkKind> {
        match s {
            "wiki" => Some(LinkKind::Wiki),
            "md" => Some(LinkKind::Md),
            _ => None,
        }
    }
}

/// `target` is what the doc says: a wiki target as written (trimmed), or a
/// Markdown path decoded and without anchor, query or title. Turning it into
/// a vault path is `Resolver`'s job, because that depends on the other docs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    pub kind: LinkKind,
    pub target: String,
}

/// In order of appearance. Frontmatter, fenced code and inline code spans are
/// skipped: a link there is an example, not a reference.
pub fn parse_links(content: &str) -> Vec<Link> {
    let (_, body) = parse_frontmatter(content);
    let mut links = Vec::new();
    // The opening fence's character and length; only a matching fence closes it.
    let mut fence: Option<(char, usize)> = None;
    for line in body.lines() {
        let trimmed = line.trim_start();
        let marker = trimmed.chars().next().filter(|c| *c == '`' || *c == '~');
        let run = marker.map_or(0, |m| trimmed.chars().take_while(|c| *c == m).count());
        match (fence, marker) {
            (None, Some(m)) if run >= 3 => {
                fence = Some((m, run));
                continue;
            }
            (Some((open, len)), Some(m)) if m == open && run >= len => {
                fence = None;
                continue;
            }
            (Some(_), _) => continue,
            _ => {}
        }
        scan_line(line, &mut links);
    }
    links
}

fn scan_line(line: &str, links: &mut Vec<Link>) {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'`' => i = skip_code_span(line, i),
            b'[' if bytes.get(i + 1) == Some(&b'[') => {
                let Some(len) = line[i + 2..].find("]]") else {
                    i += 2;
                    continue;
                };
                let inner = &line[i + 2..i + 2 + len];
                let target = inner.split(['|', '#']).next().unwrap_or_default().trim();
                if !target.is_empty() {
                    links.push(Link {
                        kind: LinkKind::Wiki,
                        target: target.to_owned(),
                    });
                }
                i += 2 + len + 2;
            }
            b'[' => {
                let is_image = i > 0 && bytes[i - 1] == b'!';
                match md_link(line, i) {
                    Some((href, end)) => {
                        if !is_image && let Some(target) = md_target(href) {
                            links.push(Link {
                                kind: LinkKind::Md,
                                target,
                            });
                        }
                        i = end;
                    }
                    None => i += 1,
                }
            }
            _ => i += 1,
        }
    }
}

/// Index after the code span that starts at `start`, or after the backtick
/// run when it is never closed (then the backticks are plain text).
fn skip_code_span(line: &str, start: usize) -> usize {
    let bytes = line.as_bytes();
    let run = bytes[start..].iter().take_while(|b| **b == b'`').count();
    let mut i = start + run;
    while i < bytes.len() {
        if bytes[i] == b'`' {
            let close = bytes[i..].iter().take_while(|b| **b == b'`').count();
            if close == run {
                return i + close;
            }
            i += close;
        } else {
            i += 1;
        }
    }
    start + run
}

/// `[text](href "title")` starting at `open`: the raw href and the index
/// after the closing `)`.
fn md_link(line: &str, open: usize) -> Option<(&str, usize)> {
    let bytes = line.as_bytes();
    let mut depth = 0;
    let mut i = open;
    let close = loop {
        match bytes.get(i)? {
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    break i;
                }
            }
            _ => {}
        }
        i += 1;
    };
    if bytes.get(close + 1) != Some(&b'(') {
        return None;
    }
    let mut i = close + 2;
    while bytes.get(i).is_some_and(|b| *b == b' ' || *b == b'\t') {
        i += 1;
    }
    let href_start = i;
    let href = if bytes.get(i) == Some(&b'<') {
        let len = line[i + 1..].find('>')?;
        i += 1 + len + 1;
        &line[href_start + 1..href_start + 1 + len]
    } else {
        let mut parens = 0;
        while let Some(&b) = bytes.get(i) {
            match b {
                b' ' | b'\t' => break,
                b'(' => parens += 1,
                b')' if parens == 0 => break,
                b')' => parens -= 1,
                _ => {}
            }
            i += 1;
        }
        &line[href_start..i]
    };
    // A quoted title may itself contain `)`.
    let rest = line[i..].trim_start();
    let rest_start = line.len() - rest.len();
    let after_title = match rest.chars().next() {
        Some(q @ ('"' | '\'')) => rest_start + 1 + rest[1..].find(q)? + 1,
        _ => rest_start,
    };
    let end = after_title + line[after_title..].find(')')? + 1;
    Some((href, end))
}

/// The vault-path part of an href, or `None` when it is not a link to a doc.
fn md_target(href: &str) -> Option<String> {
    if has_scheme(href) || href.starts_with('#') || href.starts_with("//") {
        return None;
    }
    let path = href.split(['#', '?']).next().unwrap_or_default();
    let path = percent_decode(path);
    path.ends_with(".md").then_some(path)
}

fn has_scheme(href: &str) -> bool {
    let Some((scheme, _)) = href.split_once(':') else {
        return false;
    };
    let mut chars = scheme.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
}

/// Text that does not decode to UTF-8 is kept as written.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(hex) = s.get(i + 1..i + 3)
            && let Ok(b) = u8::from_str_radix(hex, 16)
        {
            out.push(b);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_owned())
}

/// Resolves links against a fixed list of doc paths. Built once per query so
/// the lookups stay cheap for a whole vault.
pub struct Resolver {
    paths: HashMap<String, String>,
    paths_lower: HashMap<String, String>,
    /// File name without `.md` to paths, sorted by path.
    names: HashMap<String, Vec<String>>,
    names_lower: HashMap<String, Vec<String>>,
}

impl Resolver {
    pub fn new(docs: impl IntoIterator<Item = String>) -> Resolver {
        let mut docs: Vec<String> = docs.into_iter().collect();
        // Sorted so "first by path" holds for every tie below.
        docs.sort();
        docs.dedup();
        let mut resolver = Resolver {
            paths: HashMap::new(),
            paths_lower: HashMap::new(),
            names: HashMap::new(),
            names_lower: HashMap::new(),
        };
        for path in docs {
            let file = path.rsplit('/').next().unwrap_or(&path);
            let name = strip_md(file).to_owned();
            resolver
                .names_lower
                .entry(name.to_lowercase())
                .or_default()
                .push(path.clone());
            resolver.names.entry(name).or_default().push(path.clone());
            resolver
                .paths_lower
                .entry(path.to_lowercase())
                .or_insert_with(|| path.clone());
            resolver.paths.insert(path.clone(), path);
        }
        resolver
    }

    /// The vault path the link points to, or `None` when it is broken.
    pub fn resolve(&self, link: &Link, from: &str) -> Option<String> {
        match link.kind {
            LinkKind::Wiki => {
                let target = link.target.strip_suffix(".md").unwrap_or(&link.target);
                if target.contains('/') {
                    self.by_path(&format!("{}.md", target.trim_start_matches('/')))
                } else {
                    self.by_name(target, from)
                }
            }
            LinkKind::Md => {
                let (mut parts, rel) = match link.target.strip_prefix('/') {
                    Some(rel) => (Vec::new(), rel),
                    None => (folder(from).split('/').collect(), link.target.as_str()),
                };
                parts.retain(|p| !p.is_empty());
                for part in rel.split('/') {
                    match part {
                        "" | "." => {}
                        // Leaving the vault makes the link broken.
                        ".." => {
                            parts.pop()?;
                        }
                        _ => parts.push(part),
                    }
                }
                self.by_path(&parts.join("/"))
            }
        }
    }

    fn by_path(&self, path: &str) -> Option<String> {
        self.paths
            .get(path)
            .or_else(|| self.paths_lower.get(&path.to_lowercase()))
            .cloned()
    }

    fn by_name(&self, name: &str, from: &str) -> Option<String> {
        let candidates = self
            .names
            .get(name)
            .or_else(|| self.names_lower.get(&name.to_lowercase()))?;
        let here = folder(from);
        candidates
            .iter()
            .find(|p| folder(p) == here)
            // `min_by_key` keeps the first of equal keys: the first by path.
            .or_else(|| candidates.iter().min_by_key(|p| p.chars().count()))
            .cloned()
    }
}

/// `""` for a doc at the vault root.
fn folder(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(dir, _)| dir)
}

/// Doc files may end in `.MD` too (`Vault::list` accepts any case).
fn strip_md(file: &str) -> &str {
    match file.len().checked_sub(3) {
        Some(cut) if file.is_char_boundary(cut) && file[cut..].eq_ignore_ascii_case(".md") => {
            &file[..cut]
        }
        _ => file,
    }
}
