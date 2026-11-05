//! A reader for the Host blocks of an OpenSSH client config.

use crate::{HostSource, LocalForward, SshHost, TIMEOUT_MAX, TIMEOUT_MIN, valid_alias};

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
    proxy_jump: Option<Option<String>>,
    forward_agent: Option<bool>,
    local_forwards: Vec<LocalForward>,
    connect_timeout: Option<Option<u16>>,
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

/// A port in `1..=65535`.
fn port_of(text: &str) -> Option<u16> {
    text.parse::<u16>().ok().filter(|p| *p != 0)
}

/// `host:port` or `[v6]:port`.
fn host_port(text: &str) -> Option<(String, u16)> {
    if let Some(rest) = text.strip_prefix('[') {
        let (host, tail) = rest.split_once(']')?;
        return Some((host.to_owned(), port_of(tail.strip_prefix(':')?)?));
    }
    let (host, port) = text.rsplit_once(':')?;
    if host.is_empty() || host.contains(':') {
        return None;
    }
    Some((host.to_owned(), port_of(port)?))
}

/// The value of a `LocalForward` line: `[bind:]port host:hostport` (or the
/// host and port as two words). The bind address is dropped, so the port
/// listens on loopback; a Unix socket on either side is not a TCP forward.
fn local_forward(value: &str) -> Option<LocalForward> {
    let parts = words(value);
    let (listen, target) = match parts.as_slice() {
        [listen, target] => (listen.clone(), target.clone()),
        [listen, host, port] => (listen.clone(), format!("{host}:{port}")),
        _ => return None,
    };
    if listen.contains('/') || target.contains('/') {
        return None;
    }
    let local = listen.rsplit(':').next()?;
    let (remote_host, remote_port) = host_port(&target)?;
    Some(LocalForward {
        local_port: port_of(local)?,
        remote_host,
        remote_port,
    })
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
                    "proxyjump" => {
                        block.proxy_jump.get_or_insert_with(|| {
                            (!word.eq_ignore_ascii_case("none")).then_some(word)
                        });
                    }
                    "forwardagent" => {
                        let off =
                            word.eq_ignore_ascii_case("no") || word.eq_ignore_ascii_case("false");
                        block.forward_agent.get_or_insert(!off);
                    }
                    // Every LocalForward line adds one.
                    "localforward" => {
                        if let Some(f) = local_forward(&value)
                            && !block.local_forwards.contains(&f)
                        {
                            block.local_forwards.push(f);
                        }
                    }
                    "connecttimeout" => {
                        block.connect_timeout.get_or_insert_with(|| {
                            word.parse::<u32>()
                                .ok()
                                .filter(|t| *t != 0)
                                .map(|t| t.clamp(TIMEOUT_MIN.into(), TIMEOUT_MAX.into()) as u16)
                        });
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
                host_name: block.host_name.clone().unwrap_or_else(|| alias.clone()),
                alias,
                user: block.user.clone(),
                port: block.port,
                identity_file: block.identity_file.clone(),
                proxy_jump: block.proxy_jump.clone().flatten(),
                forward_agent: block.forward_agent.unwrap_or(false),
                local_forwards: block.local_forwards.clone(),
                connect_timeout_secs: block.connect_timeout.flatten(),
                source: HostSource::SshConfig,
                ..SshHost::default()
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
    fn proxy_jump_first_value_and_none() {
        let parsed = parse_config(
            "Host a
 ProxyJump me@bastion:2200,jump2
 ProxyJump other
Host b
 ProxyJump none
Host c
",
        );
        assert_eq!(
            parsed.hosts[0].proxy_jump.as_deref(),
            Some("me@bastion:2200,jump2")
        );
        assert_eq!(parsed.hosts[1].proxy_jump, None);
        assert_eq!(parsed.hosts[2].proxy_jump, None);
    }

    #[test]
    fn forward_agent_yes_and_no() {
        let parsed = parse_config(FIXTURE);
        assert!(parsed.hosts[0].forward_agent);
        let db = parsed.hosts.iter().find(|h| h.alias == "db").unwrap();
        assert!(!db.forward_agent);
        let parsed = parse_config(
            "Host a
 ForwardAgent no
 ForwardAgent yes
Host b
 forwardagent=True
",
        );
        assert!(!parsed.hosts[0].forward_agent);
        assert!(parsed.hosts[1].forward_agent);
    }

    #[test]
    fn local_forwards_are_all_kept() {
        let parsed = parse_config(
            "Host a
             LocalForward 5432 db.internal:5432
             LocalForward 127.0.0.1:8080 [::1]:80
             LocalForward 9000 web 9001
             LocalForward /tmp/sock remote:22
             LocalForward 0 x:1
             LocalForward 1234
             LocalForward 5432 db.internal:5432
",
        );
        let lf = &parsed.hosts[0].local_forwards;
        assert_eq!(
            lf,
            &[
                LocalForward {
                    local_port: 5432,
                    remote_host: "db.internal".into(),
                    remote_port: 5432
                },
                LocalForward {
                    local_port: 8080,
                    remote_host: "::1".into(),
                    remote_port: 80
                },
                LocalForward {
                    local_port: 9000,
                    remote_host: "web".into(),
                    remote_port: 9001
                },
            ]
        );
    }

    #[test]
    fn connect_timeout_is_clamped() {
        let parsed = parse_config(
            "Host a
 ConnectTimeout 15
 ConnectTimeout 3
Host b
 ConnectTimeout 600
Host c
 ConnectTimeout 0
Host d
 ConnectTimeout x
",
        );
        let t: Vec<_> = parsed
            .hosts
            .iter()
            .map(|h| h.connect_timeout_secs)
            .collect();
        assert_eq!(t, [Some(15), Some(TIMEOUT_MAX), None, None]);
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
