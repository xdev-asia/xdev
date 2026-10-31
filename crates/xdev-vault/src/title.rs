/// The first `# ` heading, else the file name without its extension.
pub fn extract_title(rel: &str, content: &str) -> String {
    let mut in_fence = false;
    for line in content.trim_start_matches('\u{feff}').lines() {
        let line = line.trim_start();
        // `# ` inside a code block is usually a shell comment, not a title.
        if line.starts_with("```") || line.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        if let Some(title) = line.strip_prefix("# ") {
            let title = title.trim();
            if !title.is_empty() {
                return title.to_owned();
            }
        }
    }
    file_stem(rel).to_owned()
}

fn file_stem(rel: &str) -> &str {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    match name.rsplit_once('.') {
        Some((stem, _)) if !stem.is_empty() => stem,
        _ => name,
    }
}
