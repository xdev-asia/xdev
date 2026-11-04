//! What happened while the app started. Each setup step is recorded as
//! `{id, ok, ms, detail}`; the UI shows a banner when one failed, and the
//! diagnostics file carries the report. Steps also go to the app log.
//! `XDEV_STARTUP_DIAGNOSTICS=1` prints each step to stderr too.

use crate::applog;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct StartupStep {
    pub id: String,
    pub ok: bool,
    pub ms: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct StartupReport {
    pub steps: Vec<StartupStep>,
}

/// Managed state. `print` is injected so tests do not read the environment.
#[derive(Default)]
pub struct Startup {
    report: Mutex<StartupReport>,
    print: bool,
}

/// Milliseconds as `u32`, saturating.
pub(crate) fn ms_of(d: Duration) -> u32 {
    u32::try_from(d.as_millis()).unwrap_or(u32::MAX)
}

/// The `[startup]` line for a step.
pub(crate) fn line(step: &StartupStep) -> String {
    let k = match &step.detail {
        Some(d) => serde_json::json!({ "detail": d }),
        None => serde_json::json!({}),
    };
    format!("[startup] {} ok={} t={} k={}", step.id, step.ok, step.ms, k)
}

impl Startup {
    pub fn new(print: bool) -> Self {
        Self {
            report: Mutex::default(),
            print,
        }
    }

    pub fn from_env() -> Self {
        Self::new(std::env::var("XDEV_STARTUP_DIAGNOSTICS").is_ok_and(|v| v == "1"))
    }

    /// Records a step; a second mark for the same id replaces the first.
    pub fn mark(&self, step: StartupStep) {
        let text = line(&step);
        if self.print {
            eprintln!("{text}");
        }
        if step.ok {
            applog::info("startup", &text);
        } else {
            applog::warn("startup", &text);
        }
        let mut report = self.report.lock().unwrap_or_else(|p| p.into_inner());
        match report.steps.iter_mut().find(|s| s.id == step.id) {
            Some(old) => *old = step,
            None => report.steps.push(step),
        }
    }

    pub fn report(&self) -> StartupReport {
        self.report
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    /// Runs `f`, times it and records the outcome.
    pub fn run(&self, id: &str, f: impl FnOnce() -> Result<(), String>) {
        let start = Instant::now();
        let result = f();
        self.mark(StartupStep {
            id: id.to_string(),
            ok: result.is_ok(),
            ms: ms_of(start.elapsed()),
            detail: result.err(),
        });
    }
}

/// A missing file is fine (first launch). A file that is not a JSON object,
/// or a newer version, means defaults or partial values are in use.
pub(crate) fn check_settings(path: &Path) -> Result<(), String> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("cannot read settings: {e}")),
    };
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| "settings file is not valid JSON; defaults are in use".to_string())?;
    if !value.is_object() {
        return Err("settings file is not a JSON object; defaults are in use".to_string());
    }
    let version = value
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    if version > u64::from(crate::settings::VERSION) {
        return Err(format!(
            "settings file is version {version}, newer than this build's {}",
            crate::settings::VERSION
        ));
    }
    Ok(())
}

/// The folder exists (or can be made) and a file can be written in it.
pub(crate) fn check_writable(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot make folder: {e}"))?;
    let probe = dir.join(format!(".xdev-write-test-{}", std::process::id()));
    std::fs::write(&probe, b"x").map_err(|e| format!("folder is not writable: {e}"))?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

#[tauri::command]
pub fn startup_report(state: tauri::State<'_, Startup>) -> StartupReport {
    state.report()
}

#[tauri::command]
pub fn startup_mark(state: tauri::State<'_, Startup>, step: StartupStep) {
    state.mark(StartupStep {
        id: crate::crash::clip(&step.id, 80),
        detail: step.detail.map(|d| {
            crate::crash::clip(
                &crate::redact::redact_text(&d, crate::applog::home_dir().as_deref()),
                240,
            )
        }),
        ..step
    });
}

#[tauri::command]
pub fn app_relaunch(app: tauri::AppHandle) {
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_dirs::long_temp_dir;

    fn step(id: &str, ok: bool, ms: u32) -> StartupStep {
        StartupStep {
            id: id.into(),
            ok,
            ms,
            detail: None,
        }
    }

    #[test]
    fn steps_keep_their_order_and_a_repeat_replaces() {
        let s = Startup::new(false);
        s.mark(step("a", true, 1));
        s.mark(step("b", false, 2));
        s.mark(step("a", false, 3));
        let ids: Vec<_> = s
            .report()
            .steps
            .iter()
            .map(|x| (x.id.clone(), x.ok))
            .collect();
        assert_eq!(ids, [("a".to_string(), false), ("b".to_string(), false)]);
    }

    #[test]
    fn ms_saturates() {
        assert_eq!(ms_of(Duration::from_millis(5)), 5);
        assert_eq!(ms_of(Duration::from_secs(u64::MAX / 2)), u32::MAX);
    }

    #[test]
    fn the_line_has_the_startup_format() {
        assert_eq!(
            line(&step("ptyd", true, 12)),
            "[startup] ptyd ok=true t=12 k={}"
        );
        let mut bad = step("settings", false, 3);
        bad.detail = Some("not an object".into());
        assert_eq!(
            line(&bad),
            r#"[startup] settings ok=false t=3 k={"detail":"not an object"}"#
        );
    }

    #[test]
    fn run_times_and_records_the_outcome() {
        let s = Startup::new(false);
        s.run("ok", || Ok(()));
        s.run("bad", || Err("no".into()));
        let steps = s.report().steps;
        assert!(steps[0].ok && steps[0].detail.is_none());
        assert!(!steps[1].ok && steps[1].detail.as_deref() == Some("no"));
    }

    #[test]
    fn settings_check_covers_missing_object_and_newer() {
        let dir = long_temp_dir("startup");
        let path = dir.path().join("settings.json");
        assert!(check_settings(&path).is_ok(), "missing is first launch");
        std::fs::write(&path, r#"{"version":1,"ui":{}}"#).unwrap();
        assert!(check_settings(&path).is_ok());
        std::fs::write(&path, "[1,2]").unwrap();
        assert!(
            check_settings(&path)
                .unwrap_err()
                .contains("not a JSON object")
        );
        std::fs::write(&path, "{ broken").unwrap();
        assert!(check_settings(&path).is_err());
        std::fs::write(&path, r#"{"version":999}"#).unwrap();
        assert!(check_settings(&path).unwrap_err().contains("newer"));
    }

    #[test]
    fn writable_check_makes_the_folder_and_fails_on_a_file() {
        let dir = long_temp_dir("startup");
        let sub = dir.path().join("a").join("b");
        assert!(check_writable(&sub).is_ok());
        assert!(sub.is_dir());
        let file = dir.path().join("f");
        std::fs::write(&file, "x").unwrap();
        assert!(check_writable(&file.join("x")).is_err());
    }
}
