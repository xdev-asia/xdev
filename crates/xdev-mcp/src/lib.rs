//! MCP server over stdio and Streamable HTTP on 127.0.0.1.

pub const NAME: &str = env!("CARGO_PKG_NAME");

#[cfg(test)]
mod tests {
    #[test]
    fn name_matches_package() {
        assert_eq!(super::NAME, "xdev-mcp");
    }
}
