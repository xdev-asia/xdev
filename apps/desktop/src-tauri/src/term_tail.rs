//! The text a terminal printed, kept on the Rust side so the CLI can read a
//! tab without asking the UI: escape sequences stripped, capped per PTY.

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
}
