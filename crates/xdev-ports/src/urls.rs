//! The URLs a terminal prints (`Local: http://localhost:5173/`), kept per
//! worktree and port, so the panel can open what the program itself announced.

use std::collections::HashMap;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use url::{Host, Url};

use crate::attribute::norm_path;

/// The longest partial line kept per terminal, in bytes.
pub const LINE_BUFFER: usize = 4096;
/// The longest URL read.
pub const URL_MAX: usize = 2048;
/// The most origins kept; the least recently seen goes first.
pub const ENTRY_CAP: usize = 256;

/// Removes what a terminal sends besides text, so a URL under colour codes or
/// a progress redraw still reads as one. OSC sequences and other control
/// sequences go; a sequence that moves the cursor or erases leaves a space,
/// so the text on each side does not run together; line breaks and tabs
/// become spaces; other control characters go.
pub fn strip_controls(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => match chars.peek().copied() {
                // OSC: up to BEL or ESC \.
                Some(']') => {
                    chars.next();
                    while let Some(n) = chars.next() {
                        if n == '\u{7}' {
                            break;
                        }
                        if n == '\u{1b}' {
                            if chars.peek() == Some(&'\\') {
                                chars.next();
                            }
                            break;
                        }
                    }
                }
                // CSI: parameters, then one final byte.
                Some('[') => {
                    chars.next();
                    let mut last = None;
                    for n in chars.by_ref() {
                        if ('\u{40}'..='\u{7e}').contains(&n) {
                            last = Some(n);
                            break;
                        }
                    }
                    if matches!(last, Some('A'..='H' | 'J' | 'K' | 'f' | 'd')) {
                        out.push(' ');
                    }
                }
                // Two-byte escape: ESC and one of @ to _.
                Some(n) if ('\u{40}'..='\u{5f}').contains(&n) => {
                    chars.next();
                }
                _ => {}
            },
            '\n' | '\r' | '\t' => out.push(' '),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

/// Whether `bytes` holds `http`, in any case. The cheap test before the regex.
fn holds_http(bytes: &[u8]) -> bool {
    bytes.windows(4).any(|w| w.eq_ignore_ascii_case(b"http"))
}

fn is_wildcard(host: &Host<&str>) -> bool {
    match host {
        Host::Domain(d) => d.is_empty() || *d == "*",
        Host::Ipv4(ip) => ip.is_unspecified(),
        Host::Ipv6(ip) => ip.is_unspecified(),
    }
}

/// The http(s) URLs in already-stripped text, each trimmed of the punctuation
/// that ends a sentence. A URL that is too long, does not parse, or points at
/// a wildcard host (`0.0.0.0`, `::`, `*`) is dropped.
pub fn find_urls(text: &str) -> Vec<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r#"(?i)\bhttps?://[^\s<>"'`]+"#).expect("url pattern"));
    re.find_iter(text)
        .filter_map(|m| {
            let raw = m
                .as_str()
                .trim_end_matches(['.', ',', ';', ':', '!', '?', ')', ']', '}', '>', '\'', '"']);
            if raw.len() > URL_MAX {
                return None;
            }
            let url = Url::parse(raw).ok()?;
            if !matches!(url.scheme(), "http" | "https") {
                return None;
            }
            if is_wildcard(&url.host()?) {
                return None;
            }
            Some(raw.to_owned())
        })
        .collect()
}

/// How much a host is worth when two URLs name the same port: a DNS name, then
/// loopback, then a private address, then a public one.
fn host_rank(host: &Host<&str>) -> u8 {
    let private4 = |ip: &Ipv4Addr| ip.is_private() || ip.is_link_local();
    let private6 = |ip: &Ipv6Addr| {
        (ip.segments()[0] & 0xfe00) == 0xfc00 || (ip.segments()[0] & 0xffc0) == 0xfe80
    };
    match host {
        Host::Domain(_) => 3,
        Host::Ipv4(ip) if ip.is_loopback() => 2,
        Host::Ipv6(ip) if ip.is_loopback() => 2,
        Host::Ipv4(ip) if private4(ip) => 1,
        Host::Ipv6(ip) if private6(ip) => 1,
        _ => 0,
    }
}

struct Entry {
    origin: String,
    /// Host rank, then 1 for https: the part of the preference that is not recency.
    score: (u8, u8),
    pty: String,
    pid: Option<u32>,
    /// A scan has already missed this port once.
    absent: bool,
    seen: u64,
}

struct PtyLine {
    worktree: PathBuf,
    pending: Vec<u8>,
}

/// The origins terminals printed, per worktree and port.
#[derive(Default)]
pub struct AdvertisedUrls {
    entries: HashMap<(String, u16), Entry>,
    ptys: HashMap<String, PtyLine>,
    clock: u64,
}

impl AdvertisedUrls {
    /// Reads a chunk of the output of terminal `pty`, which runs in
    /// `worktree`. Only whole lines are read; the rest waits for its line
    /// break. True when it added or changed an origin.
    pub fn ingest(&mut self, pty: &str, worktree: &Path, bytes: &[u8]) -> bool {
        let line = self.ptys.entry(pty.to_owned()).or_insert_with(|| PtyLine {
            worktree: worktree.to_path_buf(),
            pending: Vec::new(),
        });
        line.worktree = worktree.to_path_buf();
        line.pending.extend_from_slice(bytes);
        let Some(end) = line
            .pending
            .iter()
            .rposition(|b| matches!(b, b'\n' | b'\r'))
        else {
            Self::cap(&mut line.pending);
            return false;
        };
        let rest = line.pending.split_off(end + 1);
        let whole = std::mem::replace(&mut line.pending, rest);
        Self::cap(&mut line.pending);
        if !holds_http(&whole) {
            return false;
        }
        let text = strip_controls(&String::from_utf8_lossy(&whole));
        let mut changed = false;
        for url in find_urls(&text) {
            changed |= self.keep(pty, worktree, &url);
        }
        changed
    }

    /// Keeps the last `LINE_BUFFER` bytes of an unfinished line.
    fn cap(pending: &mut Vec<u8>) {
        if pending.len() > LINE_BUFFER {
            let cut = pending.len() - LINE_BUFFER;
            pending.drain(..cut);
        }
    }

    fn keep(&mut self, pty: &str, worktree: &Path, raw: &str) -> bool {
        let Ok(url) = Url::parse(raw) else {
            return false;
        };
        let (Some(host), Some(port)) = (url.host(), url.port_or_known_default()) else {
            return false;
        };
        let origin = url.origin().ascii_serialization();
        let score = (host_rank(&host), u8::from(url.scheme() == "https"));
        self.clock += 1;
        let key = (norm_path(worktree), port);
        let seen = self.clock;
        if let Some(old) = self.entries.get_mut(&key) {
            old.seen = seen;
            old.pty = pty.to_owned();
            if score < old.score {
                return false;
            }
            let changed = old.origin != origin;
            old.origin = origin;
            old.score = score;
            if changed {
                old.pid = None;
                old.absent = false;
            }
            return changed;
        }
        self.entries.insert(
            key,
            Entry {
                origin,
                score,
                pty: pty.to_owned(),
                pid: None,
                absent: false,
                seen,
            },
        );
        if self.entries.len() > ENTRY_CAP
            && let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, e)| e.seen)
                .map(|(k, _)| k.clone())
        {
            self.entries.remove(&oldest);
        }
        true
    }

    /// Forgets terminal `pty`: its unfinished line and every origin it printed.
    pub fn forget_pty(&mut self, pty: &str) {
        self.ptys.remove(pty);
        self.entries.retain(|_, e| e.pty != pty);
    }

    /// The origin printed for `port` in `worktree`.
    pub fn lookup(&self, worktree: &Path, port: u16) -> Option<String> {
        self.entries
            .get(&(norm_path(worktree), port))
            .map(|e| e.origin.clone())
    }

    /// Checks the origins against a scan's workspace ports `(worktree, port,
    /// pid)`. An origin whose port now has another pid is dropped, and so is
    /// one whose port a second scan in a row did not list.
    pub fn reconcile(&mut self, listening: &[(PathBuf, u16, Option<u32>)]) {
        let live: HashMap<(String, u16), Option<u32>> = listening
            .iter()
            .map(|(w, port, pid)| ((norm_path(w), *port), *pid))
            .collect();
        self.entries.retain(|key, entry| match live.get(key) {
            Some(pid) => {
                entry.absent = false;
                match (entry.pid, pid) {
                    (Some(old), Some(new)) if old != *new => false,
                    (None, Some(new)) => {
                        entry.pid = Some(*new);
                        true
                    }
                    _ => true,
                }
            }
            None if entry.absent => false,
            None => {
                entry.absent = true;
                true
            }
        });
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: &str = "/w/a";

    fn feed(urls: &mut AdvertisedUrls, pty: &str, text: &str) -> bool {
        urls.ingest(pty, Path::new(W), text.as_bytes())
    }

    fn found(text: &str) -> Vec<String> {
        find_urls(&strip_controls(text))
    }

    #[test]
    fn colour_codes_and_osc_do_not_hide_a_url() {
        let line = "\u{1b}[32m  Local:\u{1b}[0m   \u{1b}[36mhttp://localhost:\u{1b}[1m5173\u{1b}[22m/\u{1b}[39m\n";
        assert_eq!(found(line), vec!["http://localhost:5173/"]);
        let osc = "\u{1b}]8;;http://hidden:1\u{7}Open\u{1b}]8;;\u{7} http://a.test:81/x\u{1b}]0;title\u{1b}\\\n";
        assert_eq!(found(osc), vec!["http://a.test:81/x"]);
        assert_eq!(strip_controls("a\u{8}b\u{1b}Mc\u{0}d"), "abcd");
    }

    #[test]
    fn a_cursor_move_does_not_glue_two_pieces() {
        let text = "http://localhost:3000/\u{1b}[2Khttp://localhost:3001/";
        assert_eq!(
            found(text),
            vec!["http://localhost:3000/", "http://localhost:3001/"]
        );
        assert_eq!(strip_controls("a\u{1b}[10Cb"), "a b");
    }

    #[test]
    fn trailing_punctuation_is_trimmed() {
        let text = "see (http://localhost:3000/docs), or \"http://a.test:9/x.\" and <http://b.test:8/y>! http://c.test:7?";
        assert_eq!(
            found(text),
            vec![
                "http://localhost:3000/docs",
                "http://a.test:9/x",
                "http://b.test:8/y",
                "http://c.test:7"
            ]
        );
    }

    #[test]
    fn wildcard_hosts_and_other_schemes_are_dropped() {
        let text = "http://0.0.0.0:3000 http://[::]:3001/ http://*:3002 ftp://x.test/ http://ok.test:3003/";
        assert_eq!(found(text), vec!["http://ok.test:3003/"]);
        let long = format!("http://a.test/{}", "x".repeat(URL_MAX));
        assert!(found(&long).is_empty());
    }

    #[test]
    fn a_url_split_across_chunks_is_read_once_its_line_ends() {
        let mut urls = AdvertisedUrls::default();
        assert!(!feed(&mut urls, "p", "  Local: http://local"));
        assert!(!feed(&mut urls, "p", "host:51"));
        assert_eq!(urls.lookup(Path::new(W), 5173), None);
        assert!(feed(&mut urls, "p", "73/\r\n"));
        assert_eq!(
            urls.lookup(Path::new(W), 5173).as_deref(),
            Some("http://localhost:5173")
        );
        // The same URL again is not new.
        assert!(!feed(&mut urls, "p", "http://localhost:5173/\n"));
    }

    #[test]
    fn only_the_last_4096_bytes_of_an_unfinished_line_are_kept() {
        let mut urls = AdvertisedUrls::default();
        let filler = "x".repeat(LINE_BUFFER + 100);
        assert!(!feed(
            &mut urls,
            "p",
            &format!("http://localhost:4000/ {filler}")
        ));
        assert!(!feed(&mut urls, "p", "\n"));
        assert_eq!(urls.lookup(Path::new(W), 4000), None);
        // A URL inside the kept tail survives.
        assert!(!feed(
            &mut urls,
            "q",
            &format!("{filler} http://localhost:4001/")
        ));
        assert!(feed(&mut urls, "q", "\n"));
        assert!(urls.lookup(Path::new(W), 4001).is_some());
    }

    #[test]
    fn two_urls_for_a_port_prefer_dns_then_loopback_then_private_then_public_then_https() {
        let mut urls = AdvertisedUrls::default();
        let port = |urls: &AdvertisedUrls| urls.lookup(Path::new(W), 3000).unwrap();
        feed(&mut urls, "p", "http://8.8.8.8:3000/\n");
        assert_eq!(port(&urls), "http://8.8.8.8:3000");
        assert!(feed(&mut urls, "p", "http://192.168.1.5:3000/\n"));
        assert_eq!(port(&urls), "http://192.168.1.5:3000");
        assert!(feed(&mut urls, "p", "http://127.0.0.1:3000/\n"));
        assert_eq!(port(&urls), "http://127.0.0.1:3000");
        assert!(feed(&mut urls, "p", "http://localhost:3000/\n"));
        assert_eq!(port(&urls), "http://localhost:3000");
        assert!(!feed(&mut urls, "p", "http://127.0.0.1:3000/\n"));
        assert_eq!(port(&urls), "http://localhost:3000");
        assert!(feed(&mut urls, "p", "https://localhost:3000/\n"));
        assert_eq!(port(&urls), "https://localhost:3000");
        assert!(!feed(&mut urls, "p", "http://localhost:3000/\n"));
        assert_eq!(port(&urls), "https://localhost:3000");
        // Same rank, same scheme: the newest wins.
        assert!(feed(&mut urls, "p", "https://dev.test:3000/\n"));
        assert!(feed(&mut urls, "p", "https://other.test:3000/\n"));
        assert_eq!(port(&urls), "https://other.test:3000");
    }

    #[test]
    fn a_default_port_is_filled_in() {
        let mut urls = AdvertisedUrls::default();
        feed(&mut urls, "p", "https://app.test/\nhttp://web.test/\n");
        assert!(urls.lookup(Path::new(W), 443).is_some());
        assert!(urls.lookup(Path::new(W), 80).is_some());
    }

    #[test]
    fn the_least_recently_seen_origin_goes_at_256() {
        let mut urls = AdvertisedUrls::default();
        for port in 1000..(1000 + ENTRY_CAP as u16) {
            assert!(feed(&mut urls, "p", &format!("http://localhost:{port}/\n")));
        }
        assert_eq!(urls.len(), ENTRY_CAP);
        // Seeing the oldest again protects it.
        assert!(!feed(&mut urls, "p", "http://localhost:1000/\n"));
        assert!(feed(&mut urls, "p", "http://localhost:9000/\n"));
        assert_eq!(urls.len(), ENTRY_CAP);
        assert!(urls.lookup(Path::new(W), 1000).is_some());
        assert!(urls.lookup(Path::new(W), 1001).is_none());
        assert!(urls.lookup(Path::new(W), 9000).is_some());
    }

    #[test]
    fn forgetting_a_terminal_drops_its_origins_and_its_pending_line() {
        let mut urls = AdvertisedUrls::default();
        feed(&mut urls, "a", "http://localhost:3000/\n");
        feed(&mut urls, "b", "http://localhost:3001/\nhttp://loc");
        urls.forget_pty("a");
        urls.forget_pty("b");
        assert_eq!(urls.len(), 0);
        assert!(!feed(&mut urls, "b", "alhost:3002/\n"));
        assert_eq!(urls.len(), 0);
    }

    #[test]
    fn a_worktree_is_matched_by_its_normalised_path() {
        let mut urls = AdvertisedUrls::default();
        urls.ingest("p", Path::new("/w/a/"), b"http://localhost:3000/\n");
        assert!(urls.lookup(Path::new("/w/a"), 3000).is_some());
        assert!(urls.lookup(Path::new("/w/b"), 3000).is_none());
    }

    #[test]
    fn reconcile_drops_a_changed_pid_and_the_second_absent_scan() {
        let mut urls = AdvertisedUrls::default();
        feed(
            &mut urls,
            "p",
            "http://localhost:3000/\nhttp://localhost:3001/\nhttp://localhost:3002/\n",
        );
        let at = |port, pid| (PathBuf::from(W), port, pid);

        // First scan: 3000 and 3001 listen (pids learnt); 3002 is absent once.
        urls.reconcile(&[at(3000, Some(10)), at(3001, Some(11))]);
        assert_eq!(urls.len(), 3);
        // 3002 comes up before the next scan: its absence was tolerated.
        urls.reconcile(&[at(3000, Some(10)), at(3001, Some(12)), at(3002, None)]);
        assert!(urls.lookup(Path::new(W), 3000).is_some());
        assert!(urls.lookup(Path::new(W), 3001).is_none(), "pid changed");
        assert!(urls.lookup(Path::new(W), 3002).is_some());
        // 3000 goes missing twice in a row.
        urls.reconcile(&[at(3002, None)]);
        assert!(urls.lookup(Path::new(W), 3000).is_some());
        urls.reconcile(&[at(3002, None)]);
        assert!(urls.lookup(Path::new(W), 3000).is_none());
    }
}
