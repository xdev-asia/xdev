//! Exports agent context: AGENTS.md, CLAUDE.md, GEMINI.md and Cursor rules.

pub const NAME: &str = env!("CARGO_PKG_NAME");

#[cfg(test)]
mod tests {
    #[test]
    fn name_matches_package() {
        assert_eq!(super::NAME, "xdev-export");
    }
}
