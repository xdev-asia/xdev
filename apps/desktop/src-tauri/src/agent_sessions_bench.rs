//! A heavy history, on demand: 3000 Claude and 1000 Codex logs, about 2 GB,
//! some lines of 20 MB, half the files older than the history window. Prints
//! time, bytes read and peak memory of the first refresh, the second refresh
//! and the first text index build.
//!
//! `cargo test -p xdev-desktop --release bench_heavy_history -- --ignored --nocapture`
//! The home is built once under `XDEV_BENCH_DIR` (else the temp dir) and kept.

use std::fs;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime};

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use xdev_kit::HomeSource;

use super::*;

const CLAUDE_FILES: usize = 3000;
const CODEX_FILES: usize = 1000;
/// Files that carry one line of `HUGE_LINE` bytes.
const HUGE_EVERY: usize = 100;
const HUGE_LINE: usize = 20 << 20;
const DONE: &str = "bench-done-v2";

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 33
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// Text with escapes, as tool output has.
fn filler(rng: &mut Rng, len: usize) -> String {
    const WORDS: [&str; 8] = [
        "fn main() {",
        "let x = 1;",
        "\\n",
        "\\\"quoted\\\"",
        "path/to/file.rs",
        "error[E0308]:",
        "\\t",
        "ok",
    ];
    let mut s = String::with_capacity(len + 16);
    while s.len() < len {
        s.push_str(WORDS[rng.below(8) as usize]);
        s.push(' ');
    }
    s
}

/// A JSON array body of short strings, as an edit's structured patch.
fn patch_lines(rng: &mut Rng, len: usize) -> String {
    let mut s = String::with_capacity(len + 32);
    while s.len() < len {
        if !s.is_empty() {
            s.push(',');
        }
        s.push_str(&format!(r#""+ line {}""#, rng.below(1000)));
    }
    s
}

fn ts(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil from days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

fn set_mtime(path: &Path, ms: i64) {
    let at = SystemTime::UNIX_EPOCH + Duration::from_millis(u64::try_from(ms).unwrap());
    fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(at)
        .unwrap();
}

fn claude_file(path: &Path, n: usize, rng: &mut Rng, start_ms: i64, cwd: &str) -> i64 {
    let mut w = BufWriter::new(fs::File::create(path).unwrap());
    let id = format!("c{n:05}");
    let target = 20_000 + rng.below(560_000) as usize;
    let mut written = 0;
    let mut at = start_ms;
    let mut turn = 0;
    let huge = n.is_multiple_of(HUGE_EVERY);
    while written < target || turn < 2 {
        at += 1000 + rng.below(30_000) as i64;
        let tool_len = if huge && turn == 1 {
            HUGE_LINE
        } else {
            2_000 + rng.below(60_000) as usize
        };
        let head = format!(
            r#""isSidechain":false,"userType":"external","cwd":{cwd},"sessionId":"{id}","version":"2.0.0","gitBranch":"main""#
        );
        let prompt = if turn == 0 && n.is_multiple_of(7) {
            // A pasted screenshot with the prompt.
            format!(
                r#"[{{"type":"image","source":{{"type":"base64","media_type":"image/png","data":"{}"}}}},{{"type":"text","text":"fix the layout {n}"}}]"#,
                "A".repeat(200_000 + rng.below(800_000) as usize)
            )
        } else {
            format!(r#""prompt {n} turn {turn}: {}""#, filler(rng, 200))
        };
        let lines = [
            format!(
                r#"{{"parentUuid":null,{head},"type":"user","message":{{"role":"user","content":{prompt}}},"uuid":"u{turn}","timestamp":"{}"}}"#,
                ts(at)
            ),
            format!(
                r#"{{"parentUuid":"u{turn}",{head},"message":{{"id":"msg_{n}_{turn}","type":"message","role":"assistant","model":"claude-opus-4","content":[{{"type":"text","text":"{}"}}],"usage":{{"input_tokens":10,"output_tokens":20}}}},"type":"assistant","uuid":"a{turn}","timestamp":"{}"}}"#,
                filler(rng, 1500),
                ts(at + 500)
            ),
            format!(
                r#"{{"parentUuid":"a{turn}",{head},"message":{{"id":"msg_{n}_{turn}","type":"message","role":"assistant","model":"claude-opus-4","content":[{{"type":"tool_use","id":"t{turn}","name":"Read","input":{{"file_path":"/x/y.rs"}}}}]}},"type":"assistant","uuid":"b{turn}","timestamp":"{}"}}"#,
                ts(at + 600)
            ),
            format!(
                r#"{{"parentUuid":"b{turn}",{head},"type":"user","message":{{"role":"user","content":[{{"tool_use_id":"t{turn}","type":"tool_result","content":"{}"}}]}},"toolUseResult":{{"structuredPatch":[{{"lines":[{}]}}]}},"uuid":"r{turn}","timestamp":"{}"}}"#,
                filler(rng, tool_len / 2),
                patch_lines(rng, tool_len / 2),
                ts(at + 900)
            ),
        ];
        for l in lines {
            w.write_all(l.as_bytes()).unwrap();
            w.write_all(b"\n").unwrap();
            written += l.len() + 1;
        }
        turn += 1;
    }
    w.flush().unwrap();
    at
}

fn codex_file(path: &Path, n: usize, rng: &mut Rng, start_ms: i64, id: &str, cwd: &str) -> i64 {
    let mut w = BufWriter::new(fs::File::create(path).unwrap());
    let target = 20_000 + rng.below(560_000) as usize;
    let mut at = start_ms;
    let mut lines = vec![
        format!(
            r#"{{"timestamp":"{}","type":"session_meta","payload":{{"id":"{id}","timestamp":"{}","cwd":{cwd},"originator":"codex_cli_rs","cli_version":"0.40.0","instructions":"{}","git":{{"commit_hash":"abc","branch":"main"}}}}}}"#,
            ts(at),
            ts(at),
            filler(rng, 8_000)
        ),
        format!(
            r#"{{"timestamp":"{}","type":"turn_context","payload":{{"cwd":{cwd},"approval_policy":"on-request","model":"gpt-5-codex"}}}}"#,
            ts(at)
        ),
    ];
    let mut written: usize = lines.iter().map(String::len).sum();
    let mut turn = 0;
    let huge = n.is_multiple_of(HUGE_EVERY);
    while written < target || turn < 2 {
        at += 1000 + rng.below(30_000) as i64;
        let tool_len = if huge && turn == 1 {
            HUGE_LINE
        } else {
            2_000 + rng.below(60_000) as usize
        };
        let batch = [
            format!(
                r#"{{"timestamp":"{}","type":"response_item","payload":{{"type":"message","role":"user","content":[{{"type":"input_text","text":"task {n} turn {turn}: {}"}}]}}}}"#,
                ts(at),
                filler(rng, 200)
            ),
            format!(
                r#"{{"timestamp":"{}","type":"event_msg","payload":{{"type":"user_message","message":"task {n} turn {turn}","kind":"plain"}}}}"#,
                ts(at)
            ),
            format!(
                r#"{{"timestamp":"{}","type":"response_item","payload":{{"type":"function_call_output","call_id":"c{turn}","output":"{}"}}}}"#,
                ts(at + 300),
                filler(rng, tool_len)
            ),
            format!(
                r#"{{"timestamp":"{}","type":"response_item","payload":{{"type":"message","role":"assistant","content":[{{"type":"output_text","text":"{}"}}]}}}}"#,
                ts(at + 600),
                filler(rng, 1500)
            ),
        ];
        for l in &batch {
            written += l.len() + 1;
        }
        lines.extend(batch);
        for l in lines.drain(..) {
            w.write_all(l.as_bytes()).unwrap();
            w.write_all(b"\n").unwrap();
        }
        turn += 1;
    }
    w.flush().unwrap();
    at
}

/// Builds the home under `root` once; returns its total size.
fn build_home(root: &Path, now: i64) -> u64 {
    let done = root.join(DONE);
    if let Ok(s) = fs::read_to_string(&done) {
        return s.trim().parse().unwrap();
    }
    let _ = fs::remove_dir_all(root);
    let cwd = serde_json::to_string(&root.join("w").to_string_lossy()).unwrap();
    fs::create_dir_all(root.join("w")).unwrap();
    let mut rng = Rng(42);
    let mut total = 0;
    for n in 0..CLAUDE_FILES {
        let dir = root
            .join("user")
            .join(".claude")
            .join("projects")
            .join(format!("-p{}", n % 60));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("c{n:05}.jsonl"));
        // Odd files are 200 days old, past the 90-day window.
        let age = if n % 2 == 1 { 200 } else { 1 + (n % 30) as i64 };
        let last = claude_file(&path, n, &mut rng, now - age * DAY_MS, &cwd);
        set_mtime(&path, last);
        total += fs::metadata(&path).unwrap().len();
    }
    for n in 0..CODEX_FILES {
        let dir = root
            .join("user")
            .join(".codex")
            .join("sessions")
            .join("2030")
            .join(format!("{:02}", 1 + n % 12))
            .join(format!("{:02}", 1 + n % 28));
        fs::create_dir_all(&dir).unwrap();
        let id = format!("01a1a18f-2257-7d10-81b3-{n:012x}");
        let path = dir.join(format!("rollout-2030-01-01T00-00-00-{id}.jsonl"));
        let age = if n % 2 == 1 { 200 } else { 1 + (n % 30) as i64 };
        let last = codex_file(&path, n, &mut rng, now - age * DAY_MS, &id, &cwd);
        set_mtime(&path, last);
        total += fs::metadata(&path).unwrap().len();
    }
    fs::write(&done, total.to_string()).unwrap();
    total
}

fn homes_of(root: &Path) -> Vec<Home> {
    vec![
        Home {
            id: "own-claude".into(),
            agent: Agent::Claude,
            path: root.join("user").join(".claude"),
            source: HomeSource::Own,
        },
        Home {
            id: "own-codex".into(),
            agent: Agent::Codex,
            path: root.join("user").join(".codex"),
            source: HomeSource::Own,
        },
    ]
}

/// Peak working set and read bytes of this process while `f` runs.
fn measure<T>(label: &str, f: impl FnOnce() -> T) -> T {
    let pid = Pid::from_u32(std::process::id());
    let probe = move |sys: &mut System| {
        sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid]),
            false,
            ProcessRefreshKind::nothing()
                .with_memory()
                .with_disk_usage(),
        );
        let p = sys.process(pid).unwrap();
        (p.memory(), p.disk_usage().total_read_bytes)
    };
    let mut sys = System::new().unwrap();
    let (mem0, read0) = probe(&mut sys);
    let stop = Arc::new(AtomicBool::new(false));
    let peak = Arc::new(AtomicU64::new(mem0));
    let sampler = {
        let (stop, peak) = (stop.clone(), peak.clone());
        std::thread::spawn(move || {
            let mut sys = System::new().unwrap();
            while !stop.load(Ordering::SeqCst) {
                peak.fetch_max(probe(&mut sys).0, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(5));
            }
        })
    };
    let t = Instant::now();
    let out = f();
    let took = t.elapsed();
    stop.store(true, Ordering::SeqCst);
    sampler.join().unwrap();
    let (mem1, read1) = probe(&mut sys);
    let peak = peak.load(Ordering::SeqCst).max(mem1);
    println!(
        "{label:<22} time {:>8.2} s   read {:>8.1} MB   peak +{:>7.1} MB (working set {:.1} MB)",
        took.as_secs_f64(),
        (read1 - read0) as f64 / 1e6,
        (peak.saturating_sub(mem0)) as f64 / 1e6,
        peak as f64 / 1e6,
    );
    out
}

#[test]
#[ignore = "builds about 2 GB of logs; run on demand"]
fn bench_heavy_history() {
    let base = std::env::var_os("XDEV_BENCH_DIR").map_or_else(
        || std::env::temp_dir().join("xdev-sessions-bench"),
        PathBuf::from,
    );
    let now = now_ms();
    let root = base.join("home");
    let t = Instant::now();
    let total = build_home(&root, now);
    println!(
        "home: {CLAUDE_FILES} claude + {CODEX_FILES} codex logs, {:.2} GB (ready in {:.1} s)",
        total as f64 / 1e9,
        t.elapsed().as_secs_f64()
    );
    let data = base.join("data");
    let _ = fs::remove_dir_all(&data);
    fs::create_dir_all(&data).unwrap();
    // Not the global index of another test.
    let homes = homes_of(&root);
    let q = SessionQuery {
        text: None,
        scope: SessionScope::All,
        agent: None,
        home_id: None,
        sort: SessionSort::LastDesc,
        limit: 100,
    };
    let cutoff = history_cutoff(now, HISTORY_DAYS);
    // Every log read, the window aside: the cost of the reading alone.
    let stats = measure("refresh, no window", || {
        SessionIndex::default().refresh_since(&homes, None, &mut |_| {})
    });
    println!("  files {} bytes {}", stats.files_read, stats.bytes);
    let rows = measure("first refresh", || {
        sessions(&data, || homes.clone(), &q, Some(cutoff), None).unwrap()
    });
    println!("  rows {}", rows.len());
    let rows = measure("second refresh", || {
        sessions(&data, || homes.clone(), &q, Some(cutoff), None).unwrap()
    });
    println!("  rows {}", rows.len());
    let keep: HashSet<String> = SessionIndex::load(&data)
        .list()
        .iter()
        .map(|s| s.key.clone())
        .collect();
    let path = search_path(&data);
    measure("first text index", || {
        refresh_text_in(&path, &homes, &keep, Some(cutoff), TEXT_BATCH).unwrap();
    });
    let (s, m, _) = read_counts(&path).unwrap();
    println!("  text index: {s} sessions, {m} messages");
    measure("second text index", || {
        refresh_text_in(&path, &homes, &keep, Some(cutoff), TEXT_BATCH).unwrap();
    });

    // A list asked for while a first build runs.
    let data2 = base.join("data2");
    let _ = fs::remove_dir_all(&data2);
    fs::create_dir_all(&data2).unwrap();
    let build = {
        let (data2, homes, q) = (data2.clone(), homes.clone(), q.clone());
        std::thread::spawn(move || {
            sessions(&data2, || homes, &q, Some(cutoff), None).unwrap();
        })
    };
    std::thread::sleep(Duration::from_millis(1_000));
    let t = Instant::now();
    let rows = sessions(&data2, || homes.clone(), &q, None, None).unwrap();
    println!(
        "list 1 s into a first build: answered in {:.2} s with {} rows",
        t.elapsed().as_secs_f64(),
        rows.len()
    );
    build.join().unwrap();
}
