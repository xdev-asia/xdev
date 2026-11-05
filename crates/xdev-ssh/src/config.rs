//! A reader for the Host blocks of an OpenSSH client config.

use crate::{HostSource, SshHost, valid_alias};

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ParsedConfig {
    /// One per concrete alias, in file order, first spelling wins.
    pub hosts: Vec<SshHost>,
    /// What was left out and why, for a line under the sync button.
    pub notes: Vec<String>,
    /// An `Include` line was seen and not followed.
    pub include_seen: bool,
    /// How many `Host` patterns were wildcards, negated or not a usable alias.
    pub skipped_patterns: usize,
}

#[derive(Default)]
struct Block {
    aliases: Vec<String>,
    host_name: Option<String>,
    user: Option<String>,
    port: Option<u16>,
    identity_file: Option<String>,
}

/// The `key` and `value` of one line: `Key value` or `Key=value`, keys case
/// insensitive (returned lowercase), a quoted value unquoted. `None` for a
/// blank line or a comment.
fn split_line(line: &str) -> Option<(String, String)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let end = line.find(|c: char| c.is_whitespace() || c == '=')?;
    let key = line[..end].to_ascii_lowercase();
    let rest = line[end..].trim_start();
    let rest = rest.strip_prefix('=').unwrap_or(rest).trim();
    Some((key, rest.to_owned()))
}

/// The first word of a value, or the text inside its first quotes.
fn first_word(value: &str) -> String {
    if let Some(rest) = value.strip_prefix('"') {
        return rest.split('"').next().unwrap_or("").to_owned();
    }
    value.split_whitespace().next().unwrap_or("").to_owned()
}

/// Every word of a `Host` line, quotes removed.
fn words(value: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = value.trim();
    while !rest.is_empty() {
        if let Some(inner) = rest.strip_prefix('"') {
            let (word, tail) = inner.split_once('"').unwrap_or((inner, ""));
            out.push(word.to_owned());
            rest = tail.trim_start();
        } else {
            let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
            out.push(rest[..end].to_owned());
            rest = rest[end..].trim_start();
        }
    }
    out
}

pub fn parse_config(text: &str) -> ParsedConfig {
    let mut out = ParsedConfig::default();
    let mut blocks: Vec<Block> = Vec::new();
    // False before the first Host line and inside a `Match` block.
    let mut open = false;
    let mut include = false;
    let mut skipped_patterns = 0usize;

    for line in text.lines() {
        let Some((key, value)) = split_line(line) else {
            continue;
        };
        match key.as_str() {
            "host" => {
                let mut block = Block::default();
                for pattern in words(&value) {
                    let wild = pattern.contains(['*', '?']) || pattern.starts_with('!');
                    if wild || !valid_alias(&pattern) {
                        skipped_patterns += 1;
                    } else {
                        block.aliases.push(pattern);
                    }
                }
                blocks.push(block);
                open = true;
            }
            "match" => open = false,
            "include" => include = true,
            _ if !open => {}
            other => {
                let Some(block) = blocks.last_mut() else {
                    continue;
                };
                let word = first_word(&value);
                if word.is_empty() {
                    continue;
                }
                // ssh keeps the first value it sees for a key.
                match other {
                    "hostname" => {
                        block.host_name.get_or_insert(word);
                    }
                    "user" => {
                        block.user.get_or_insert(word);
                    }
                    "port" => {
                        if block.port.is_none() {
                            block.port = word.parse::<u16>().ok().filter(|p| *p != 0);
                        }
                    }
                    "identityfile" => {
                        block.identity_file.get_or_insert(word);
                    }
                    _ => {}
                }
            }
        }
    }

    for block in blocks {
        for alias in block.aliases {
            if out.hosts.iter().any(|h| h.alias == alias) {
                continue;
            }
            out.hosts.push(SshHost {
                id: String::new(),
                host_name: block.host_name.clone().unwrap_or_else(|| alias.clone()),
                alias,
                user: block.user.clone(),
                port: block.port,
                identity_file: block.identity_file.clone(),
                source: HostSource::SshConfig,
            });
        }
    }
    out.include_seen = include;
    out.skipped_patterns = skipped_patterns;
    if skipped_patterns > 0 {
        out.notes.push(format!(
            "skipped {skipped_patterns} wildcard or negated pattern(s)"
        ));
    }
    if include {
        out.notes.push("Include lines are not followed".to_owned());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = "\
# my hosts
Include ~/.ssh/config.d/*

Host *
    ServerAliveInterval 30
    User everyone

Host web
    HostName web.example.com
    User deploy
    Port 2222
    IdentityFile ~/.ssh/web_ed25519
    ForwardAgent yes

host=db db-replica
  hostname = 10.0.0.5
  USER=admin

Host !bad good
  HostName good.example.com

Host quoted
  IdentityFile \"/path with space/key\"
  Port 70000

Match host foo
  User nobody

Host bare
";

    #[test]
    fn parses_host_blocks() {
        let parsed = parse_config(FIXTURE);
        let aliases: Vec<_> = parsed.hosts.iter().map(|h| h.alias.as_str()).collect();
        assert_eq!(
            aliases,
            ["web", "db", "db-replica", "good", "quoted", "bare"]
        );
        let web = &parsed.hosts[0];
        assert_eq!(web.host_name, "web.example.com");
        assert_eq!(web.user.as_deref(), Some("deploy"));
        assert_eq!(web.port, Some(2222));
        assert_eq!(web.identity_file.as_deref(), Some("~/.ssh/web_ed25519"));
        assert_eq!(web.source, HostSource::SshConfig);
        assert!(web.id.is_empty());
    }

    #[test]
    fn keys_are_case_insensitive_and_take_equals() {
        let parsed = parse_config(FIXTURE);
        for alias in ["db", "db-replica"] {
            let h = parsed.hosts.iter().find(|h| h.alias == alias).unwrap();
            assert_eq!(h.host_name, "10.0.0.5");
            assert_eq!(h.user.as_deref(), Some("admin"));
        }
    }

    #[test]
    fn host_name_defaults_to_alias_and_bad_port_is_dropped() {
        let parsed = parse_config(FIXTURE);
        let bare = parsed.hosts.iter().find(|h| h.alias == "bare").unwrap();
        assert_eq!(bare.host_name, "bare");
        let quoted = parsed.hosts.iter().find(|h| h.alias == "quoted").unwrap();
        assert_eq!(quoted.port, None);
        assert_eq!(
            quoted.identity_file.as_deref(),
            Some("/path with space/key")
        );
    }

    #[test]
    fn wildcards_and_match_blocks_are_skipped() {
        let parsed = parse_config(FIXTURE);
        assert!(
            parsed
                .hosts
                .iter()
                .all(|h| h.alias != "*" && h.alias != "bad")
        );
        // `User nobody` belongs to the Match block, not to `quoted`.
        let quoted = parsed.hosts.iter().find(|h| h.alias == "quoted").unwrap();
        assert_eq!(quoted.user, None);
    }

    #[test]
    fn include_is_noted_not_followed() {
        let parsed = parse_config(FIXTURE);
        assert!(parsed.notes.iter().any(|n| n.contains("Include")));
        assert!(parsed.notes.iter().any(|n| n.contains("wildcard")));
        assert!(parse_config("Host a\n").notes.is_empty());
    }

    #[test]
    fn first_value_wins_and_duplicates_collapse() {
        let parsed = parse_config("Host a\n User one\n User two\nHost a\n User three\n");
        assert_eq!(parsed.hosts.len(), 1);
        assert_eq!(parsed.hosts[0].user.as_deref(), Some("one"));
    }

    #[test]
    fn empty_and_junk_input() {
        assert!(parse_config("").hosts.is_empty());
        assert!(parse_config("User x\nPort 22\n").hosts.is_empty());
        assert!(parse_config("# only a comment\r\n\r\n").hosts.is_empty());
        let crlf = parse_config("Host a\r\n  HostName h\r\n");
        assert_eq!(crlf.hosts[0].host_name, "h");
    }
}
