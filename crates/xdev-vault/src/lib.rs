//! Reads and writes Markdown files, parses frontmatter, watches the vault and hashes content.

pub const NAME: &str = env!("CARGO_PKG_NAME");

#[cfg(test)]
mod tests {
    #[test]
    fn name_matches_package() {
        assert_eq!(super::NAME, "xdev-vault");
    }
}
