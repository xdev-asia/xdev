//! The diagnostics file: one JSON record per line, redacted, written where
//! the person picks. It holds the app log, the settings, the keybindings, the
//! startup report and the crash reports. Nothing is uploaded; the person
//! reads the file before they share it.

use crate::commands::CmdError;
use crate::crash::CrashReport;
use crate::redact::{redact_text, redact_value};
use crate::startup::StartupReport;
use serde::Serialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// What an export answers: where the file went and how big it is.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsExport {
    pub path: String,
    pub bytes: u64,
}

pub(crate) const SCHEMA_VERSION: u32 = 1;
/// The whole file; log records go first when it is too large.
pub(crate) const MAX_BYTES: usize = 4 * 1024 * 1024;
/// A source file larger than this is not read.
pub(crate) const MAX_SOURCE: u64 = 50 * 1024 * 1024;

pub(crate) struct BundleInput {
    pub bundle_id: String,
    pub app_version: String,
    pub machine_name: String,
    pub platform: String,
    pub arch: String,
    pub collected_at: String,
    pub settings: Option<Value>,
    pub keybindings: Option<String>,
    pub startup: StartupReport,
    pub crash_reports: Vec<CrashReport>,
    /// Log lines, oldest first, as they are in the files.
    pub log_lines: Vec<String>,
    pub home: Option<PathBuf>,
}

/// `2026-11-04T09:30:00Z` from milliseconds since the epoch.
pub(crate) fn iso(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil date from a day count (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

fn record(v: Value) -> String {
    v.to_string()
}

/// Builds the file's text. Records, in order: header, settings, keybindings,
/// startup, crash reports, then log records newest first. The text stays
/// within `cap` bytes: the other records always stay, and log records are
/// dropped oldest first.
pub(crate) fn build_bundle(input: &BundleInput, cap: usize) -> String {
    let home = input.home.as_deref();
    let mut records = vec![record(json!({
        "type": "bundle-header",
        "bundle_id": input.bundle_id,
        "app_version": input.app_version,
        "machine_name": input.machine_name,
        "platform": input.platform,
        "arch": input.arch,
        "collected_at": input.collected_at,
        "schema_version": SCHEMA_VERSION,
    }))];
    let mut settings = input.settings.clone().unwrap_or(Value::Null);
    redact_value(&mut settings, home);
    records.push(record(json!({ "type": "settings", "value": settings })));
    records.push(record(json!({
        "type": "keybindings",
        "text": redact_text(input.keybindings.as_deref().unwrap_or(""), home),
    })));
    let mut startup = serde_json::to_value(&input.startup).unwrap_or(Value::Null);
    redact_value(&mut startup, home);
    records.push(record(json!({ "type": "startup", "report": startup })));
    let mut crashes = serde_json::to_value(&input.crash_reports).unwrap_or(Value::Null);
    redact_value(&mut crashes, home);
    records.push(record(
        json!({ "type": "crash-reports", "reports": crashes }),
    ));

    let mut used: usize = records.iter().map(|r| r.len() + 1).sum();
    for line in input.log_lines.iter().rev() {
        let Ok(Value::Object(mut obj)) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(Value::String(msg)) = obj.get_mut("msg") {
            *msg = redact_text(msg, home);
        }
        obj.insert("type".into(), Value::String("log".into()));
        let text = record(Value::Object(obj));
        if used + text.len() + 1 > cap {
            break;
        }
        used += text.len() + 1;
        records.push(text);
    }
    records.join("\n") + "\n"
}

/// The lines of the log files, oldest first. `files` come newest first, as
/// `applog::files` lists them. A missing or huge file is skipped, and so is
/// a line that is not UTF-8.
pub(crate) fn read_log_lines(files: &[PathBuf], max_source: u64) -> Vec<String> {
    let mut lines = Vec::new();
    for file in files.iter().rev() {
        let Ok(meta) = std::fs::metadata(file) else {
            continue;
        };
        if meta.len() > max_source {
            continue;
        }
        let Ok(bytes) = std::fs::read(file) else {
            continue;
        };
        lines.extend(
            bytes
                .split(|b| *b == b'\n')
                .filter_map(|l| std::str::from_utf8(l).ok())
                .map(|l| l.trim_end_matches('\r'))
                .filter(|l| !l.trim().is_empty())
                .map(str::to_string),
        );
    }
    lines
}

fn diag_error(detail: impl ToString) -> CmdError {
    CmdError {
        code: "diag_write",
        detail: Some(detail.to_string()),
    }
}

fn is_ndjson(path: &Path) -> bool {
    path.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("ndjson"))
}

/// The suggested file name: only a plain name, always ending in `.ndjson`.
pub(crate) fn export_file_name(suggested: &str) -> String {
    let name = Path::new(suggested)
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.is_empty())
        .unwrap_or("xdev-diagnostics");
    if is_ndjson(Path::new(name)) {
        name.to_string()
    } else {
        format!("{name}.ndjson")
    }
}

/// Writes the bundle to `path`; answers the bytes written. Only an
/// `.ndjson` file is ever written, so the command cannot overwrite other
/// files.
pub(crate) fn write_bundle(path: &Path, input: &BundleInput) -> Result<u64, CmdError> {
    if !is_ndjson(path) {
        return Err(diag_error("the diagnostics file must end in .ndjson"));
    }
    let text = build_bundle(input, MAX_BYTES);
    crate::atomic::write_atomic(path, text.as_bytes()).map_err(diag_error)?;
    Ok(text.len() as u64)
}

fn collect(app: &tauri::AppHandle) -> BundleInput {
    use tauri::Manager;
    let local = app.state::<crate::commands::AppState>().local_dir.clone();
    let settings = crate::commands::settings_path(app)
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    let keybindings = crate::keybindings::file_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok());
    let crash_reports = local
        .as_ref()
        .and_then(|l| crate::crash::load(&crate::crash::store_path(l)).ok())
        .unwrap_or_default();
    let log_files = local
        .as_ref()
        .map(|l| crate::applog::files(&l.join("logs")))
        .unwrap_or_default();
    BundleInput {
        bundle_id: uuid::Uuid::new_v4().to_string(),
        app_version: xdev_core::version().to_string(),
        machine_name: crate::network::machine_name(&crate::settings_store::read(app).network),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        collected_at: iso(crate::workspace::clock().0),
        settings,
        keybindings,
        startup: app.state::<crate::startup::Startup>().report(),
        crash_reports,
        log_lines: read_log_lines(&log_files, MAX_SOURCE),
        home: crate::applog::home_dir(),
    }
}

/// Asks where to save, in a native dialog opened here so the path never
/// comes from the webview, then writes the file. `None` means the person
/// cancelled.
#[tauri::command(async)]
pub fn diagnostics_export(
    app: tauri::AppHandle,
    default_name: String,
) -> Result<Option<DiagnosticsExport>, CmdError> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .set_file_name(export_file_name(&default_name))
        .add_filter("Diagnostics", &["ndjson"])
        .blocking_save_file();
    let Some(picked) = picked else {
        return Ok(None);
    };
    let mut path = picked.into_path().map_err(diag_error)?;
    if !is_ndjson(&path) {
        path.set_extension("ndjson");
    }
    let bytes = write_bundle(&path, &collect(&app))?;
    Ok(Some(DiagnosticsExport {
        path: path.to_string_lossy().into_owned(),
        bytes,
    }))
}

/// Shows an exported file in the file manager. Only an existing `.ndjson`
/// file is accepted.
#[tauri::command]
pub fn diagnostics_reveal_export(path: String) -> Result<(), CmdError> {
    let path = PathBuf::from(path);
    if !is_ndjson(&path) || !path.is_file() {
        return Err(diag_error("not a diagnostics file"));
    }
    crate::reveal::reveal(&path, true).map_err(diag_error)
}

/// Opens the folder the app log lives in.
#[tauri::command]
pub fn diagnostics_reveal_logs(app: tauri::AppHandle) -> Result<(), CmdError> {
    use tauri::Manager;
    let local = app.state::<crate::commands::AppState>().local_dir.clone();
    let dir = local
        .map(|l| l.join("logs"))
        .ok_or_else(|| diag_error("no local data folder"))?;
    std::fs::create_dir_all(&dir).map_err(diag_error)?;
    crate::reveal::reveal(&dir, false).map_err(diag_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_dirs::long_temp_dir;

    fn input() -> BundleInput {
        BundleInput {
            bundle_id: "id".into(),
            app_version: "1.0.0".into(),
            machine_name: "dev box".into(),
            platform: "windows".into(),
            arch: "x86_64".into(),
            collected_at: "2026-11-04T00:00:00Z".into(),
            settings: Some(json!({"ui": {"zoom": 1.5}, "githubToken": "ghp_x", "env": {"A": "b"}})),
            keybindings: Some("{\"k\": \"password=abc\"}".into()),
            startup: StartupReport::default(),
            crash_reports: vec![],
            log_lines: (0..5)
                .map(|i| {
                    json!({"ts": i, "level": "info", "target": "t", "msg": format!("m{i}")})
                        .to_string()
                })
                .collect(),
            home: None,
        }
    }

    fn parse(text: &str) -> Vec<Value> {
        text.lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    #[test]
    fn header_is_first_and_the_records_follow_in_order() {
        let got = parse(&build_bundle(&input(), MAX_BYTES));
        let types: Vec<_> = got.iter().map(|r| r["type"].as_str().unwrap()).collect();
        assert_eq!(
            &types[..5],
            [
                "bundle-header",
                "settings",
                "keybindings",
                "startup",
                "crash-reports"
            ]
        );
        assert!(types[5..].iter().all(|t| *t == "log"));
        assert_eq!(got[0]["schema_version"], 1);
        assert_eq!(got[0]["bundle_id"], "id");
        assert_eq!(got[0]["platform"], "windows");
    }

    #[test]
    fn settings_and_keybindings_are_redacted() {
        let got = parse(&build_bundle(&input(), MAX_BYTES));
        assert_eq!(got[1]["value"], json!({"ui": {"zoom": 1.5}}));
        let text = got[2]["text"].as_str().unwrap();
        assert!(!text.contains("abc"));
        assert!(text.contains("password=[redacted]"));
    }

    #[test]
    fn logs_come_newest_first_and_are_re_redacted() {
        let mut inp = input();
        inp.log_lines
            .push(json!({"ts": 9, "level": "warn", "target": "t", "msg": "token=zzz"}).to_string());
        let got = parse(&build_bundle(&inp, MAX_BYTES));
        let logs: Vec<_> = got.iter().filter(|r| r["type"] == "log").collect();
        assert_eq!(logs.len(), 6);
        assert_eq!(logs[0]["ts"], 9);
        assert_eq!(logs[0]["msg"], "token=[redacted]");
        assert_eq!(logs.last().unwrap()["ts"], 0);
    }

    #[test]
    fn a_line_that_is_not_json_is_skipped() {
        let mut inp = input();
        inp.log_lines.push("not json".into());
        let got = parse(&build_bundle(&inp, MAX_BYTES));
        assert_eq!(got.iter().filter(|r| r["type"] == "log").count(), 5);
    }

    #[test]
    fn the_cap_drops_the_oldest_logs_and_keeps_the_rest() {
        let inp = input();
        let full = build_bundle(&inp, MAX_BYTES);
        let one_log = full.lines().last().unwrap().len() + 1;
        let cap = full.len() - 2 * one_log;
        let text = build_bundle(&inp, cap);
        assert!(text.len() <= cap);
        let got = parse(&text);
        let logs: Vec<_> = got.iter().filter(|r| r["type"] == "log").collect();
        assert_eq!(logs.len(), 3);
        // The newest three stay.
        assert_eq!(logs[0]["ts"], 4);
        assert_eq!(logs[2]["ts"], 2);
        assert_eq!(got[0]["type"], "bundle-header");
        assert_eq!(got[4]["type"], "crash-reports");
    }

    #[test]
    fn source_files_over_the_limit_are_skipped_and_bad_utf8_lines_too() {
        let dir = long_temp_dir("bundle");
        let live = dir.path().join("xdev.log");
        let old = dir.path().join("xdev.log.1");
        let huge = dir.path().join("xdev.log.2");
        std::fs::write(&old, "{\"a\":1}\n").unwrap();
        let mut bytes = b"{\"b\":2}\n".to_vec();
        bytes.extend_from_slice(&[0xff, 0xfe, b'\n']);
        bytes.extend_from_slice(b"{\"c\":3}\n");
        std::fs::write(&live, bytes).unwrap();
        std::fs::write(&huge, "{\"big\":1,\"pad\":\"xxxxxxxxxxxxxxxxxxxx\"}\n").unwrap();
        // Newest first, as `applog::files` lists them; the third file is
        // over the 20 byte limit.
        let lines = read_log_lines(&[live, old, huge.clone()], 20);
        assert_eq!(lines, ["{\"a\":1}", "{\"b\":2}", "{\"c\":3}"]);
        let lines = read_log_lines(&[huge], 5);
        assert!(lines.is_empty());
        // A missing file is skipped.
        assert!(read_log_lines(&[dir.path().join("none.log")], 100).is_empty());
    }

    #[test]
    fn iso_formats_utc() {
        assert_eq!(iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso(1_794_000_000_000), "2026-11-06T21:20:00Z");
        assert_eq!(iso(951_782_400_000 + 86_399_000), "2000-02-29T23:59:59Z");
    }

    #[test]
    fn only_an_ndjson_file_is_written() {
        let dir = long_temp_dir("bundle");
        let victim = dir.path().join("settings.json");
        std::fs::write(&victim, "keep").unwrap();
        let err = write_bundle(&victim, &input()).unwrap_err();
        assert_eq!(err.code, "diag_write");
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep");
        assert!(write_bundle(&dir.path().join("a.NDJSON"), &input()).is_ok());
    }

    #[test]
    fn the_suggested_name_is_a_plain_ndjson_name() {
        assert_eq!(export_file_name("a.ndjson"), "a.ndjson");
        assert_eq!(export_file_name("a.json"), "a.json.ndjson");
        assert_eq!(export_file_name("../../x/evil"), "evil.ndjson");
        assert_eq!(export_file_name(""), "xdev-diagnostics.ndjson");
    }

    #[test]
    fn revealing_a_file_that_is_not_an_export_is_refused() {
        let dir = long_temp_dir("bundle");
        let other = dir.path().join("x.txt");
        std::fs::write(&other, "x").unwrap();
        assert!(diagnostics_reveal_export(other.to_string_lossy().into_owned()).is_err());
        let missing = dir.path().join("none.ndjson");
        assert!(diagnostics_reveal_export(missing.to_string_lossy().into_owned()).is_err());
    }

    #[test]
    fn write_bundle_writes_the_file_and_reports_its_size() {
        let dir = long_temp_dir("bundle");
        let path = dir.path().join("out").join("diag.ndjson");
        let size = write_bundle(&path, &input()).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(size, text.len() as u64);
        assert!(text.ends_with('\n'));
        assert_eq!(parse(&text)[0]["type"], "bundle-header");
        // A path that cannot be written is a diag_write error.
        let blocked = dir.path().join("f");
        std::fs::write(&blocked, "x").unwrap();
        let err = write_bundle(&blocked.join("x.ndjson"), &input()).unwrap_err();
        assert_eq!(err.code, "diag_write");
    }
}
