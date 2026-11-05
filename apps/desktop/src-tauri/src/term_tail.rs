//! The text a terminal printed, kept on the Rust side so the CLI can read a
//! tab without asking the UI: escape sequences stripped, capped per PTY.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;

/// Where the stripper is inside an escape sequence.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum State {
    #[default]
    Text,
    /// After ESC.
    Esc,
    /// After ESC and an intermediate byte (`ESC ( B`): until a final byte.
    EscInter,
    /// `ESC [`: until a final byte in `@`..=`~`.
    Csi,
    /// OSC, DCS, APC, PM or SOS: until BEL or ST (`ESC \`).
    Str,
    /// ESC inside a string: `\` ends it.
    StrEsc,
}

/// Removes CSI, OSC (to BEL or ST), DCS/APC/PM/SOS (to ST), two-byte ESC
/// sequences and other C0 and C1 controls except `\n` and `\t`. Every `\r`
/// is dropped, so `\r\n` becomes `\n` and a lone `\r` goes. State is kept
/// across chunks: a sequence or a UTF-8 char may be split between them.
#[derive(Debug, Default)]
pub struct Stripper {
    state: State,
    /// Text bytes not yet decoded: the start of a UTF-8 char cut by the chunk.
    pending: Vec<u8>,
}

impl Stripper {
    pub fn push(&mut self, bytes: &[u8], out: &mut String) {
        for &b in bytes {
            self.state = match self.state {
                State::Text => match b {
                    ESC => State::Esc,
                    b'\n' | b'\t' => {
                        self.pending.push(b);
                        State::Text
                    }
                    0..=0x1f | 0x7f => State::Text,
                    _ => {
                        self.pending.push(b);
                        State::Text
                    }
                },
                State::Esc => match b {
                    b'[' => State::Csi,
                    b']' | b'P' | b'_' | b'^' | b'X' => State::Str,
                    ESC => State::Esc,
                    0x20..=0x2f => State::EscInter,
                    _ => State::Text,
                },
                State::EscInter => match b {
                    ESC => State::Esc,
                    0x30..=0x7e => State::Text,
                    _ => State::EscInter,
                },
                State::Csi => match b {
                    ESC => State::Esc,
                    0x40..=0x7e => State::Text,
                    _ => State::Csi,
                },
                State::Str => match b {
                    BEL => State::Text,
                    ESC => State::StrEsc,
                    _ => State::Str,
                },
                State::StrEsc => match b {
                    b'\\' => State::Text,
                    ESC => State::StrEsc,
                    _ => State::Str,
                },
            };
        }
        self.decode(out);
    }

    /// Moves the whole chars of `pending` to `out`; a cut char stays.
    fn decode(&mut self, out: &mut String) {
        let mut rest: &[u8] = &self.pending;
        while !rest.is_empty() {
            match std::str::from_utf8(rest) {
                Ok(s) => {
                    keep(s, out);
                    rest = &[];
                }
                Err(e) => {
                    let (good, bad) = rest.split_at(e.valid_up_to());
                    keep(std::str::from_utf8(good).unwrap_or_default(), out);
                    match e.error_len() {
                        Some(n) => {
                            out.push(char::REPLACEMENT_CHARACTER);
                            rest = &bad[n..];
                        }
                        None => {
                            // The start of a char the next chunk ends.
                            rest = bad;
                            break;
                        }
                    }
                }
            }
        }
        let done = self.pending.len() - rest.len();
        self.pending.drain(..done);
    }
}

/// Appends `s` without C1 controls.
fn keep(s: &str, out: &mut String) {
    out.extend(s.chars().filter(|c| !('\u{80}'..='\u{9f}').contains(c)));
}

/// The most chars a tail keeps per PTY; older text is dropped.
pub const TAIL_MAX_CHARS: usize = 256 * 1024;

/// The stripped text of one PTY, the last `cap` chars of it. Offsets
/// (cursors) count chars since the PTY started.
#[derive(Debug)]
pub struct Tail {
    strip: Stripper,
    text: String,
    /// Chars in `text`.
    len: usize,
    /// Chars dropped from the front.
    start: u64,
    cap: usize,
}

impl Default for Tail {
    fn default() -> Tail {
        Tail::with_cap(TAIL_MAX_CHARS)
    }
}

/// What one read of a tail gives.
#[allow(dead_code)] // read by the CLI's terminal verbs as they land
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TailRead {
    pub text: String,
    /// The cursor fell out of the tail: some text after it is gone.
    pub truncated: bool,
    /// There were more lines than asked for; the first ones are left out.
    pub limited: bool,
    pub oldest_cursor: u64,
    /// Pass it next time to get only newer text; same as `latest_cursor`.
    pub next_cursor: u64,
    pub latest_cursor: u64,
    pub returned_line_count: usize,
}

impl Tail {
    pub fn with_cap(cap: usize) -> Tail {
        Tail {
            strip: Stripper::default(),
            text: String::new(),
            len: 0,
            start: 0,
            cap,
        }
    }

    pub fn push(&mut self, bytes: &[u8]) {
        let mut add = String::new();
        self.strip.push(bytes, &mut add);
        self.len += add.chars().count();
        self.text.push_str(&add);
        if self.len > self.cap {
            let drop = self.len - self.cap;
            let at = byte_at(&self.text, drop);
            self.text.drain(..at);
            self.len = self.cap;
            self.start += drop as u64;
        }
    }

    /// The offset after the last char.
    #[allow(dead_code)] // read by the CLI's terminal verbs as they land
    pub fn end(&self) -> u64 {
        self.start + self.len as u64
    }

    /// The text after `cursor` (all of it without one), at most the last
    /// `limit_lines` lines of it.
    #[allow(dead_code)] // read by the CLI's terminal verbs as they land
    pub fn read(&self, cursor: Option<u64>, limit_lines: usize) -> TailRead {
        let end = self.end();
        let from = cursor.unwrap_or(self.start);
        let truncated = from < self.start;
        let from = from.clamp(self.start, end);
        let skip = usize::try_from(from - self.start).unwrap_or(self.len);
        let after = &self.text[byte_at(&self.text, skip)..];
        let lines: Vec<&str> = after.split_inclusive('\n').collect();
        let limited = lines.len() > limit_lines;
        let kept = &lines[lines.len().saturating_sub(limit_lines)..];
        TailRead {
            text: kept.concat(),
            truncated,
            limited,
            oldest_cursor: self.start,
            next_cursor: end,
            latest_cursor: end,
            returned_line_count: kept.len(),
        }
    }
}

/// The byte index of char `n` of `s`; its length past the end.
fn byte_at(s: &str, n: usize) -> usize {
    s.char_indices().nth(n).map_or(s.len(), |(i, _)| i)
}

/// The tails of every live PTY, by PTY id (which is the tab id).
#[derive(Default)]
pub struct TermTails(Mutex<HashMap<String, Tail>>);

impl TermTails {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Tail>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn feed(&self, id: &str, bytes: &[u8]) {
        let mut tails = self.lock();
        match tails.get_mut(id) {
            Some(t) => t.push(bytes),
            None => tails.entry(id.to_owned()).or_default().push(bytes),
        }
    }

    pub fn forget(&self, id: &str) {
        self.lock().remove(id);
    }

    /// `None` when the PTY printed nothing yet or is gone.
    #[allow(dead_code)] // read by the CLI's terminal verbs as they land
    pub fn read(&self, id: &str, cursor: Option<u64>, limit_lines: usize) -> Option<TailRead> {
        self.lock().get(id).map(|t| t.read(cursor, limit_lines))
    }
}

/// Called by `pty.rs` with every chunk a PTY prints.
pub fn feed(app: &tauri::AppHandle, id: &str, bytes: &[u8]) {
    use tauri::Manager;
    app.state::<TermTails>().feed(id, bytes);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strip(chunks: &[&[u8]]) -> String {
        let mut s = Stripper::default();
        let mut out = String::new();
        for c in chunks {
            s.push(c, &mut out);
        }
        out
    }

    #[test]
    fn strips_csi_osc_and_two_byte_escapes() {
        let raw = b"\x1b[1;31mred\x1b[0m \x1b]0;title\x07plain \x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\ \
            \x1b(Bcharset \x1b=keypad \x1b7saved\x1b8 \x1bP1$r0m\x1b\\dcs \x1b[?25ltab\there\x08\x7f\x00!";
        assert_eq!(
            strip(&[raw]),
            "red plain link charset keypad saved dcs tab\there!"
        );
    }

    #[test]
    fn a_sequence_split_across_chunks_is_still_stripped() {
        assert_eq!(strip(&[b"a\x1b", b"[3", b"8;5;1", b"2mb"]), "ab");
        assert_eq!(strip(&[b"a\x1b]0;ti", b"tle\x1b", b"\\b"]), "ab");
        assert_eq!(strip(&[b"a\x1b]2;x", b"\x07b"]), "ab");
        assert_eq!(strip(&[b"a\x1b", b"(", b"Bb"]), "ab");
    }

    #[test]
    fn a_utf8_char_split_across_chunks_survives() {
        let text = "xin chào ✓ 🦀".as_bytes();
        let pieces: Vec<&[u8]> = text.chunks(1).collect();
        assert_eq!(strip(&pieces), "xin chào ✓ 🦀");
        let (a, b) = "é🦀".as_bytes().split_at(3);
        assert_eq!(strip(&[a, b]), "é🦀");
        // Bytes that are not UTF-8 become a replacement char, not a stall.
        assert_eq!(strip(&[b"a\xffb"]), "a\u{fffd}b");
        // C1 controls are dropped like C0 ones.
        assert_eq!(strip(&["a\u{9b}b".as_bytes()]), "ab");
    }

    #[test]
    fn crlf_becomes_lf_and_a_lone_cr_is_dropped() {
        assert_eq!(
            strip(&[b"one\r\ntwo\r", b"\nthree\rfour\n"]),
            "one\ntwo\nthreefour\n"
        );
    }

    #[test]
    fn tail_drops_the_oldest_chars_past_the_cap_and_moves_start() {
        let mut t = Tail::with_cap(5);
        t.push(b"ab\x1b[1m");
        assert_eq!((t.start, t.end()), (0, 2));
        t.push("cdéfg".as_bytes());
        assert_eq!((t.start, t.end()), (2, 7));
        assert_eq!(t.read(None, 10).text, "cdéfg");
        assert_eq!(t.read(None, 10).oldest_cursor, 2);
    }

    #[test]
    fn read_with_an_old_cursor_is_truncated() {
        let mut t = Tail::with_cap(4);
        t.push(b"one\ntwo\n");
        let r = t.read(Some(1), 10);
        assert!(r.truncated);
        assert_eq!(r.text, "two\n");
        assert_eq!((r.oldest_cursor, r.next_cursor), (4, 8));
        assert!(!t.read(Some(4), 10).truncated);
        // A cursor from the future reads nothing.
        assert_eq!(t.read(Some(99), 10).text, "");
    }

    #[test]
    fn read_limits_to_the_last_lines_and_says_so() {
        let mut t = Tail::default();
        t.push(b"1\n2\n3\n4");
        let r = t.read(None, 2);
        assert_eq!(
            (r.text.as_str(), r.limited, r.returned_line_count),
            ("3\n4", true, 2)
        );
        let r = t.read(None, 4);
        assert_eq!((r.limited, r.returned_line_count), (false, 4));
        t.push(b"\n");
        assert_eq!(t.read(None, 4).text, "1\n2\n3\n4\n");
        assert!(!t.read(None, 4).limited);
    }

    #[test]
    fn next_cursor_returns_only_new_text() {
        let tails = TermTails::default();
        assert_eq!(tails.read("p1", None, 10), None);
        tails.feed("p1", b"$ ls\r\n");
        let first = tails.read("p1", None, 10).unwrap();
        assert_eq!(first.text, "$ ls\n");
        tails.feed("p1", b"a.txt\r\n");
        let next = tails.read("p1", Some(first.next_cursor), 10).unwrap();
        assert_eq!(next.text, "a.txt\n");
        assert!(!next.truncated);
        assert_eq!(next.latest_cursor, 11);
    }

    #[test]
    fn forget_drops_the_tail() {
        let tails = TermTails::default();
        tails.feed("p1", b"x");
        tails.feed("p2", b"y");
        tails.forget("p1");
        assert_eq!(tails.read("p1", None, 10), None);
        assert_eq!(tails.read("p2", None, 10).unwrap().text, "y");
    }
}
