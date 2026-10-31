//! SQLite storage: metadata, FTS5 and sqlite-vec indexes, migrations.

pub const NAME: &str = env!("CARGO_PKG_NAME");

#[cfg(test)]
mod tests {
    #[test]
    fn name_matches_package() {
        assert_eq!(super::NAME, "xdev-store");
    }
}
