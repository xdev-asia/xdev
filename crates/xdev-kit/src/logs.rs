//! What the usage and session indexes share: the walk over the CLI session
//! logs, the per-file read marks, line reading and timestamps. The one place
//! that knows where each CLI keeps its logs.

use std::fs;
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{Agent, Home};

const MAX_CODEX_DEPTH: usize = 6;

/// The longest line read into memory whole. A longer one (a tool result or
/// an image of many MB) is parsed as it streams past.
pub(crate) const LINE_BUF_MAX: usize = 1 << 20;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileMark {
    pub len: u64,
    pub mtime_ns: i128,
    /// Just after the last complete line that was read.
    pub offset: u64,
    /// Key into the index's `sessions`.
    pub session: String,
    /// Message ids (API ids, not text) the reader needs to go on from
    /// `offset`: the usage index keeps the last counted Claude ids, oldest
    /// first, to skip a message logged again; the session index keeps the last
    /// Claude reply id.
    #[serde(default)]
    pub recent_ids: Vec<String>,
}

/// Where to go on reading a file that has `mark`: `None` when it did not
/// change, `Some(0)` when it was rewritten or cut, else the mark's offset.
pub(crate) fn start_at(mark: &FileMark, len: u64, mtime_ns: i128) -> Option<u64> {
    if mark.len == len && mark.mtime_ns == mtime_ns {
        return None;
    }
    let rewritten = len < mark.offset || (mark.mtime_ns != mtime_ns && len <= mark.offset);
    Some(if rewritten { 0 } else { mark.offset })
}

pub(crate) fn mtime_ns(meta: &fs::Metadata) -> i128 {
    let Ok(modified) = meta.modified() else {
        return 0;
    };
    match modified.duration_since(UNIX_EPOCH) {
        Ok(d) => i128::try_from(d.as_nanos()).unwrap_or(i128::MAX),
        Err(e) => -i128::try_from(e.duration().as_nanos()).unwrap_or(i128::MAX),
    }
}

pub(crate) fn log_files(home: &Home) -> Vec<PathBuf> {
    let mut out = Vec::new();
    match home.agent {
        Agent::Claude => {
            for dir in sorted_entries(&home.path.join("projects")) {
                if !dir.is_dir() {
                    continue;
                }
                for file in sorted_entries(&dir) {
                    if file.is_file() && has_ext(&file, "jsonl") {
                        out.push(file);
                    }
                }
            }
        }
        Agent::Codex => collect_rollouts(&home.path.join("sessions"), 0, &mut out),
    }
    out
}

fn collect_rollouts(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > MAX_CODEX_DEPTH {
        return;
    }
    for path in sorted_entries(dir) {
        if path.is_dir() {
            collect_rollouts(&path, depth + 1, out);
        } else if path.is_file()
            && has_ext(&path, "jsonl")
            && path
                .file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with("rollout-"))
        {
            out.push(path);
        }
    }
}

fn sorted_entries(dir: &Path) -> Vec<PathBuf> {
    let Ok(read) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = read.filter_map(|e| e.ok().map(|e| e.path())).collect();
    paths.sort();
    paths
}

fn has_ext(path: &Path, ext: &str) -> bool {
    path.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case(ext))
}

/// Calls `f(line_start, line)` for each complete line from `start` and
/// returns the offset just after the last `\n`. A last line without `\n` is
/// left for the next call.
pub(crate) fn for_each_line(
    path: &Path,
    start: u64,
    mut f: impl FnMut(u64, &[u8]),
) -> io::Result<u64> {
    let mut file = fs::File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut reader = BufReader::new(file);
    let mut pos = start;
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let n = reader.read_until(b'\n', &mut buf)?;
        if n == 0 || buf.last() != Some(&b'\n') {
            return Ok(pos);
        }
        let line_start = pos;
        pos += n as u64;
        let mut line = &buf[..buf.len() - 1];
        if line.last() == Some(&b'\r') {
            line = &line[..line.len() - 1];
        }
        f(line_start, line);
    }
}

/// What one `for_each_record` call did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct LineRead {
    /// Just after the last complete line.
    pub offset: u64,
    /// Lines longer than the buffer cap, parsed as they streamed.
    pub long_lines: usize,
    /// The largest capacity a line buffer reached.
    pub buf_peak: usize,
    /// Long lines that did not fit even with their strings cut short.
    pub streamed: usize,
}

/// Calls `f` with each complete, non-blank line from `start` read as `T`
/// (`None` when it does not parse). A last line without `\n` is left for
/// the next call. At most `buf_max` bytes of a line are held: a longer line
/// is parsed from the file as it is read, so only the fields `T` keeps cost
/// memory.
pub(crate) fn for_each_record<T: DeserializeOwned>(
    path: &Path,
    start: u64,
    buf_max: usize,
    mut f: impl FnMut(Option<T>),
) -> io::Result<LineRead> {
    let mut file = fs::File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut done = LineRead {
        offset: start,
        ..LineRead::default()
    };
    let mut buf: Vec<u8> = Vec::new();
    let mut short: Vec<u8> = Vec::new();
    let mut chunk = vec![0; LONG_LINE_CHUNK];
    loop {
        buf.clear();
        let mut complete = false;
        let mut long = false;
        loop {
            let avail = reader.fill_buf()?;
            if avail.is_empty() {
                break;
            }
            let (take, newline) = match avail.iter().position(|b| *b == b'\n') {
                Some(i) => (i + 1, true),
                None => (avail.len(), false),
            };
            let room = buf_max - buf.len();
            if take > room {
                grow(&mut buf, room, buf_max);
                buf.extend_from_slice(&avail[..room]);
                reader.consume(room);
                long = true;
                break;
            }
            grow(&mut buf, take, buf_max);
            buf.extend_from_slice(&avail[..take]);
            reader.consume(take);
            if newline {
                complete = true;
                break;
            }
        }
        done.buf_peak = done.buf_peak.max(buf.capacity());
        if long {
            let line_start = done.offset;
            // The line with its long strings cut short, which is what `T`
            // keeps of it anyway; most of a long line is one or two blobs.
            let mut cut = Shorten::new(buf_max);
            short.clear();
            let mut src = LineSrc {
                head: &buf,
                at: 0,
                reader: &mut reader,
                len: 0,
                ended: false,
                blank: true,
            };
            loop {
                let n = src.read(&mut chunk)?;
                if n == 0 {
                    break;
                }
                grow(&mut short, n, buf_max);
                cut.feed(&chunk[..n], &mut short);
            }
            let (ended, len, blank) = (src.ended, src.len, src.blank);
            done.buf_peak = done.buf_peak.max(short.capacity());
            if !ended {
                return Ok(done);
            }
            done.offset += len;
            done.long_lines += 1;
            if blank {
                continue;
            }
            if !cut.over {
                f(serde_json::from_slice::<T>(trim_end(&short)).ok());
                continue;
            }
            // Even cut short it does not fit: parse it again as it streams.
            done.streamed += 1;
            reader.seek(SeekFrom::Start(line_start))?;
            let mut src = LineSrc {
                head: &[],
                at: 0,
                reader: &mut reader,
                len: 0,
                ended: false,
                blank: true,
            };
            // The parser asks one byte at a time; a small buffer, which cannot
            // read past the line's end, keeps those calls cheap.
            let mut bytes = io::BufReader::with_capacity(LONG_LINE_CHUNK, &mut src);
            let parsed = {
                let mut de = serde_json::Deserializer::from_reader(&mut bytes);
                T::deserialize(&mut de).and_then(|t| de.end().map(|()| t))
            };
            // What the parser left of the line, an error's rest included.
            io::copy(&mut bytes, &mut io::sink())?;
            f(parsed.ok());
            continue;
        }
        if !complete {
            return Ok(done);
        }
        done.offset += buf.len() as u64;
        let line = trim_end(&buf);
        if !is_blank(line) {
            f(serde_json::from_slice::<T>(line).ok());
        }
    }
}

/// Room for `more` bytes in `buf`, its capacity never past `max`.
fn grow(buf: &mut Vec<u8>, more: usize, max: usize) {
    let need = buf.len() + more;
    if need > buf.capacity() {
        let want = need.max(buf.capacity() * 2).max(256).min(max);
        buf.reserve_exact(want - buf.len());
    }
}

/// A line without its `\n` or `\r\n`.
fn trim_end(line: &[u8]) -> &[u8] {
    let line = line.strip_suffix(b"\n").unwrap_or(line);
    line.strip_suffix(b"\r").unwrap_or(line)
}

/// The chunk a long line is read in.
const LONG_LINE_CHUNK: usize = 64 << 10;

/// The most bytes a string of a long line keeps: more than any field a
/// record holds (`TEXT_CHARS_MAX` chars), and a quarter of the buffer at most.
const LONG_STRING_KEEP: usize = 64 << 10;

/// Containers nested deeper than this become `null` in a long line: the
/// records read nothing below `line.message.content[i]`.
const LONG_LINE_DEPTH: usize = 4;

/// Copies a JSON line with each string cut after `keep` bytes, at a char and
/// escape boundary, and each container deeper than `LONG_LINE_DEPTH` made
/// `null`, so the copy still parses and keeps every field a record reads.
struct Shorten {
    max: usize,
    /// Containers open around the current byte.
    depth: usize,
    /// Containers open inside the one being dropped (0: none dropped).
    skip: usize,
    keep: usize,
    /// The copy reached `max`; what it holds is not the whole line.
    over: bool,
    in_str: bool,
    /// The rest of the current string is dropped.
    cut: bool,
    /// Bytes kept of the current string.
    run: usize,
    /// The last byte was a `\` inside a string.
    esc: bool,
    /// Hex digits left of a `\u` escape, and their value so far.
    hex_left: u8,
    hex: u32,
    /// A high surrogate escape that its low half must follow.
    low_due: bool,
}

impl Shorten {
    fn new(max: usize) -> Self {
        Shorten {
            max,
            depth: 0,
            skip: 0,
            keep: LONG_STRING_KEEP.min(max / 4),
            over: false,
            in_str: false,
            cut: false,
            run: 0,
            esc: false,
            hex_left: 0,
            hex: 0,
            low_due: false,
        }
    }

    fn feed(&mut self, mut chunk: &[u8], out: &mut Vec<u8>) {
        while !chunk.is_empty() {
            if self.in_str && self.cut && !self.esc {
                // Inside a dropped string only a quote or a backslash matters.
                match chunk.iter().position(|b| matches!(b, b'"' | b'\\')) {
                    Some(i) => chunk = &chunk[i..],
                    None => return,
                }
            } else if self.skip > 0 && !self.in_str {
                let stop = |b: &u8| matches!(b, b'"' | b'{' | b'}' | b'[' | b']');
                match chunk.iter().position(stop) {
                    Some(i) => chunk = &chunk[i..],
                    None => return,
                }
            }
            self.step(chunk[0], out);
            chunk = &chunk[1..];
        }
    }

    fn push(&mut self, b: u8, out: &mut Vec<u8>) {
        if out.len() < self.max {
            out.push(b);
        } else {
            self.over = true;
        }
    }

    fn step(&mut self, b: u8, out: &mut Vec<u8>) {
        if self.skip > 0 {
            self.skip_byte(b);
            return;
        }
        if !self.in_str {
            match b {
                b'{' | b'[' => {
                    self.depth += 1;
                    if self.depth > LONG_LINE_DEPTH {
                        self.skip = 1;
                        for c in *b"null" {
                            self.push(c, out);
                        }
                        return;
                    }
                }
                b'}' | b']' => self.depth = self.depth.saturating_sub(1),
                _ => {}
            }
            self.push(b, out);
            if b == b'"' {
                self.in_str = true;
                self.cut = false;
                self.run = 0;
            }
            return;
        }
        if self.cut {
            if self.esc {
                self.esc = false;
            } else if b == b'\\' {
                self.esc = true;
            } else if b == b'"' {
                self.in_str = false;
                self.push(b, out);
            }
            return;
        }
        if self.esc {
            self.esc = false;
            if b == b'u' {
                self.hex_left = 4;
                self.hex = 0;
            } else {
                self.low_due = false;
            }
            self.keep_byte(b, out);
            return;
        }
        if self.hex_left > 0 {
            self.hex = self.hex << 4 | char::from(b).to_digit(16).unwrap_or(0);
            self.hex_left -= 1;
            if self.hex_left == 0 {
                self.low_due = (0xD800..=0xDBFF).contains(&self.hex);
            }
            self.keep_byte(b, out);
            return;
        }
        if b == b'"' {
            self.in_str = false;
            self.low_due = false;
            self.push(b, out);
            return;
        }
        if b != b'\\' {
            // A high surrogate not followed by an escape stands alone.
            self.low_due = false;
        }
        if self.run >= self.keep && !self.low_due && b & 0xC0 != 0x80 {
            self.cut = true;
            self.esc = b == b'\\';
            return;
        }
        if b == b'\\' {
            self.esc = true;
        }
        self.keep_byte(b, out);
    }

    /// A byte of a dropped container.
    fn skip_byte(&mut self, b: u8) {
        if self.in_str {
            if self.esc {
                self.esc = false;
            } else if b == b'\\' {
                self.esc = true;
            } else if b == b'"' {
                self.in_str = false;
            }
            return;
        }
        match b {
            b'"' => {
                self.in_str = true;
                // Lets `feed` jump to the string's end.
                self.cut = true;
            }
            b'{' | b'[' => self.skip += 1,
            b'}' | b']' => {
                self.skip -= 1;
                if self.skip == 0 {
                    self.depth -= 1;
                }
            }
            _ => {}
        }
    }

    fn keep_byte(&mut self, b: u8, out: &mut Vec<u8>) {
        self.run += 1;
        self.push(b, out);
    }
}

/// One line as a reader: the bytes already buffered, then the file up to and
/// with the next `\n`.
struct LineSrc<'a, R> {
    head: &'a [u8],
    at: usize,
    reader: &'a mut R,
    /// Bytes given, `\n` included.
    len: u64,
    /// The `\n` was reached.
    ended: bool,
    blank: bool,
}

impl<R: BufRead> Read for LineSrc<'_, R> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if out.is_empty() || self.ended {
            return Ok(0);
        }
        let n = if self.at < self.head.len() {
            let n = out.len().min(self.head.len() - self.at);
            out[..n].copy_from_slice(&self.head[self.at..self.at + n]);
            self.at += n;
            n
        } else {
            let avail = self.reader.fill_buf()?;
            if avail.is_empty() {
                return Ok(0);
            }
            let end = avail
                .iter()
                .position(|b| *b == b'\n')
                .map_or(avail.len(), |i| i + 1);
            let n = out.len().min(end);
            out[..n].copy_from_slice(&avail[..n]);
            self.reader.consume(n);
            n
        };
        let got = &out[..n];
        if got.last() == Some(&b'\n') {
            self.ended = true;
        }
        if self.blank && !is_blank(got) {
            self.blank = false;
        }
        self.len += n as u64;
        Ok(n)
    }
}

pub(crate) fn parse_line(line: &[u8]) -> Option<Value> {
    if line.iter().all(u8::is_ascii_whitespace) {
        return None;
    }
    serde_json::from_slice::<Value>(line).ok()
}

pub(crate) fn is_blank(line: &[u8]) -> bool {
    line.iter().all(u8::is_ascii_whitespace)
}

pub(crate) fn line_time(v: &Value) -> Option<i64> {
    v.get("timestamp")
        .and_then(Value::as_str)
        .and_then(parse_ts)
}

/// `YYYY-MM-DDTHH:MM:SS[.fff…](Z|±HH:MM|±HHMM)` to unix ms. No offset means UTC.
pub(crate) fn parse_ts(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19
        || b[4] != b'-'
        || b[7] != b'-'
        || !(b[10] == b'T' || b[10] == b' ')
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let field = |from: usize, to: usize| -> Option<i64> {
        let part = s.get(from..to)?;
        if !part.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        part.parse().ok()
    };
    let (year, month, day) = (field(0, 4)?, field(5, 7)?, field(8, 10)?);
    let (hour, minute, second) = (field(11, 13)?, field(14, 16)?, field(17, 19)?);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let mut rest = s.get(19..)?;
    let mut millis = 0;
    if let Some(frac) = rest.strip_prefix('.') {
        let digits = frac.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        let first3 = format!("{:0<3}", &frac[..digits.min(3)]);
        millis = first3.parse::<i64>().ok()?;
        rest = &frac[digits..];
    }
    let offset_min = match rest {
        "" | "Z" | "z" => 0,
        _ => {
            let sign = match rest.as_bytes()[0] {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let digits: String = rest[1..].chars().filter(|c| *c != ':').collect();
            if digits.len() != 4 || !digits.bytes().all(|c| c.is_ascii_digit()) {
                return None;
            }
            let hh: i64 = digits[..2].parse().ok()?;
            let mm: i64 = digits[2..].parse().ok()?;
            sign * (hh * 60 + mm)
        }
    };
    let days = days_from_civil(year, month, day);
    let secs = days * 86_400 + hour * 3600 + minute * 60 + second - offset_min * 60;
    Some(secs * 1000 + millis)
}

/// Days since 1970-01-01 of a proleptic Gregorian date.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde::Deserialize;

    use super::*;

    #[derive(Debug, Deserialize, PartialEq)]
    struct Rec {
        #[serde(default)]
        n: u32,
        #[serde(default)]
        t: String,
    }

    fn read(content: &[u8], buf_max: usize) -> (Vec<Option<Rec>>, LineRead) {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.jsonl");
        fs::write(&file, content).unwrap();
        let mut got = Vec::new();
        let done = for_each_record::<Rec>(&file, 0, buf_max, |r| got.push(r)).unwrap();
        (got, done)
    }

    #[test]
    fn a_line_past_the_cap_streams_and_the_buffer_stays_capped() {
        let big = "x".repeat(200_000);
        let content = format!(
            "{{\"n\":1}}\n{{\"n\":2,\"skip\":\"{big}\",\"t\":\"kept\"}}\r\n  \n{{\"n\":3}}\n"
        );
        let (got, done) = read(content.as_bytes(), 1024);
        assert_eq!(
            got,
            vec![
                Some(Rec {
                    n: 1,
                    t: String::new()
                }),
                Some(Rec {
                    n: 2,
                    t: "kept".into()
                }),
                Some(Rec {
                    n: 3,
                    t: String::new()
                }),
            ]
        );
        assert_eq!((done.long_lines, done.streamed), (1, 0));
        assert!(done.buf_peak <= 1024, "buffer grew to {}", done.buf_peak);
        assert_eq!(done.offset, content.len() as u64);
    }

    #[test]
    fn long_strings_are_cut_at_char_and_escape_bounds_and_still_parse() {
        // Multi-byte chars, plain escapes and surrogate pairs across the cut.
        for blob in ["é", "\\\"", "\\uD83D\\uDE00", "ab\\n", "€x"] {
            let big = blob.repeat(20_000);
            let content = format!("{{\"skip\":\"{big}\",\"n\":7,\"t\":\"kept\"}}\n");
            let (got, done) = read(content.as_bytes(), 1024);
            assert_eq!(
                got,
                vec![Some(Rec {
                    n: 7,
                    t: "kept".into()
                })],
                "blob {blob}"
            );
            assert_eq!((done.long_lines, done.streamed), (1, 0), "blob {blob}");
            assert!(done.buf_peak <= 1024);
        }
    }

    #[test]
    fn deep_containers_of_a_long_line_are_dropped_and_it_still_parses() {
        let many = vec!["\"ab]c{\\\"\""; 20_000].join(",");
        let content = format!(
            "{{\"r\":{{\"p\":[{{\"lines\":[{many}],\"o\":{{}}}}]}},\"n\":2,\"t\":\"kept\"}}\n"
        );
        let (got, done) = read(content.as_bytes(), 1024);
        assert_eq!(
            got,
            vec![Some(Rec {
                n: 2,
                t: "kept".into()
            })]
        );
        assert_eq!((done.long_lines, done.streamed), (1, 0));
    }

    #[test]
    fn a_long_line_that_does_not_parse_is_bad_and_the_next_is_read() {
        // Not a string to cut: it is parsed as it streams.
        let content = format!("{{\"n\":{}\n{{\"n\":4}}\n", "9".repeat(5000));
        let (got, done) = read(content.as_bytes(), 512);
        assert_eq!(done.streamed, 1);
        assert_eq!(
            got,
            vec![
                None,
                Some(Rec {
                    n: 4,
                    t: String::new()
                })
            ]
        );
        assert_eq!(done.offset, content.len() as u64);
    }

    #[test]
    fn an_unfinished_last_line_is_left_long_or_short() {
        let short = "{\"n\":1}\n{\"n\":2}";
        let (got, done) = read(short.as_bytes(), 512);
        assert_eq!(got.len(), 1);
        assert_eq!(done.offset, 8);
        let long = format!("{{\"n\":1}}\n{{\"t\":\"{}\"}}", "y".repeat(4000));
        let (got, done) = read(long.as_bytes(), 512);
        assert_eq!(got.len(), 1);
        assert_eq!(done.offset, 8);
        assert_eq!(done.long_lines, 0);
    }
}
