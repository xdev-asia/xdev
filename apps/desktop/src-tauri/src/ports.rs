//! Local ports: the scan the Ports panel shows, stopping a process from it,
//! and opening its URL. The scan itself lives in `xdev-ports`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, State};
use tauri_plugin_opener::OpenerExt;
use xdev_ports::urls::AdvertisedUrls;
use xdev_ports::{OsProbe, PortScan, Probe, PtyRoot, Scanner, StopConsent, StopError};

use crate::commands::CmdError;
use crate::pty::Ptys;

/// Emitted when a terminal prints a URL not seen before.
pub const ADVERTISED_EVENT: &str = "ports://advertised";

/// The payload of `ADVERTISED_EVENT`: the worktree whose terminal printed it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PortsAdvertised {
    pub worktree: String,
}

/// At most one `ADVERTISED_EVENT` per worktree in this time.
const EVENT_GAP: Duration = Duration::from_secs(1);

/// State for the port scan.
pub struct Ports {
    scanner: Scanner<OsProbe>,
    urls: Mutex<AdvertisedUrls>,
    /// When each worktree last got an event.
    emitted: Mutex<HashMap<String, Instant>>,
}

impl Default for Ports {
    fn default() -> Self {
        Self {
            scanner: Scanner::new(OsProbe, Instant::now),
            urls: Mutex::default(),
            emitted: Mutex::default(),
        }
    }
}

impl Ports {
    /// Reads a chunk a terminal printed. The worktree to announce when the chunk
    /// held a new origin and the throttle allows an event; none otherwise.
    pub fn feed(&self, pty: &str, worktree: &Path, bytes: &[u8]) -> Option<String> {
        self.feed_at(Instant::now(), pty, worktree, bytes)
    }

    fn feed_at(&self, now: Instant, pty: &str, worktree: &Path, bytes: &[u8]) -> Option<String> {
        let fresh = self.urls.lock().ok()?.ingest(pty, worktree, bytes);
        if !fresh {
            return None;
        }
        let name = worktree.display().to_string();
        let mut emitted = self.emitted.lock().ok()?;
        if let Some(at) = emitted.get(&name)
            && now.saturating_duration_since(*at) < EVENT_GAP
        {
            return None;
        }
        emitted.insert(name.clone(), now);
        Some(name)
    }

    /// Drops what terminal `pty` printed.
    pub fn forget_pty(&self, pty: &str) {
        if let Ok(mut urls) = self.urls.lock() {
            urls.forget_pty(pty);
        }
    }
}

fn paths(worktrees: Vec<String>) -> Vec<PathBuf> {
    worktrees.into_iter().map(PathBuf::from).collect()
}

fn scan_in<P: Probe>(
    scanner: &Scanner<P>,
    urls: &Mutex<AdvertisedUrls>,
    roots: &[PtyRoot],
    worktrees: &[PathBuf],
    force: bool,
) -> PortScan {
    // No terminal of these worktrees runs: the OS is not read at all.
    if !xdev_ports::attribute::has_terminal(roots, worktrees) {
        return PortScan::no_terminal();
    }
    scanner.scan(roots, worktrees, urls, force)
}

fn stop_error(error: StopError) -> CmdError {
    CmdError {
        code: error.code(),
        detail: match error {
            StopError::Failed(why) => Some(why),
            _ => None,
        },
    }
}

fn stop_in<P: Probe>(
    scanner: &Scanner<P>,
    urls: &Mutex<AdvertisedUrls>,
    roots: &[PtyRoot],
    worktrees: &[PathBuf],
    id: &str,
    consent: StopConsent,
    protected: &[u32],
) -> Result<PortScan, CmdError> {
    scanner
        .stop(id, consent, roots, worktrees, urls, protected)
        .map_err(stop_error)
}

/// The URL of port `id` in the last scan, when it is one the OS browser may open.
fn open_target_in<P: Probe>(scanner: &Scanner<P>, id: &str) -> Result<String, CmdError> {
    let port = scanner
        .last()
        .and_then(|scan| scan.ports.into_iter().find(|p| p.id == id))
        .ok_or(CmdError {
            code: "port_gone",
            detail: None,
        })?;
    let allowed = url::Url::parse(&port.url)
        .map(|u| matches!(u.scheme(), "http" | "https"))
        .unwrap_or(false);
    if !allowed {
        return Err(CmdError {
            code: "open_failed",
            detail: Some("not a web address".into()),
        });
    }
    Ok(port.url)
}

/// One scan. The window passes its worktrees so no registry is read here.
#[tauri::command(async)]
pub fn ports_scan(
    ports: State<'_, Ports>,
    ptys: State<'_, Ptys>,
    worktrees: Vec<String>,
    force: bool,
) -> Result<PortScan, CmdError> {
    Ok(scan_in(
        &ports.scanner,
        &ports.urls,
        &ptys.roots(),
        &paths(worktrees),
        force,
    ))
}

/// Stops the process behind the port `id`, then returns a fresh scan.
/// Refuses unless `confirmed`; a port no xDev terminal started (matched by
/// folder or command only) also needs `outside_terminal`, the second
/// confirmation.
#[tauri::command(async)]
pub fn ports_stop(
    ports: State<'_, Ports>,
    ptys: State<'_, Ptys>,
    worktrees: Vec<String>,
    id: String,
    confirmed: bool,
    outside_terminal: bool,
) -> Result<PortScan, CmdError> {
    let consent = StopConsent {
        confirmed,
        outside_terminal,
    };
    // The app itself and the terminal service are never stopped from here.
    let mut protected = vec![std::process::id()];
    protected.extend(ptys.service_pid());
    stop_in(
        &ports.scanner,
        &ports.urls,
        &ptys.roots(),
        &paths(worktrees),
        &id,
        consent,
        &protected,
    )
}

/// Opens the URL of the port `id` from the last scan in the OS browser. The
/// webview never passes a URL.
#[tauri::command]
pub fn ports_open(app: AppHandle, ports: State<'_, Ports>, id: String) -> Result<(), CmdError> {
    let url = open_target_in(&ports.scanner, &id)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| CmdError {
            code: "open_failed",
            detail: Some(e.to_string()),
        })
}

/// Feeds a chunk to the URL watcher and tells the window about a new origin.
pub fn feed_output(app: &AppHandle, pty: &str, worktree: &Path, bytes: &[u8]) {
    use tauri::Manager;
    let ports = app.state::<Ports>();
    if let Some(worktree) = ports.feed(pty, worktree, bytes) {
        let _ = app.emit(ADVERTISED_EVENT, PortsAdvertised { worktree });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use xdev_ports::{Listener, Proc, ScanError};

    /// Pid 7 listens on 5173 until it is stopped; pid 8 on 22 throughout.
    #[derive(Default)]
    struct Fake {
        stopped: AtomicBool,
        /// Reads of the OS tables.
        calls: AtomicUsize,
    }

    impl Probe for Fake {
        fn listeners(&self, _t: Duration) -> Result<Vec<Listener>, ScanError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let mut out = vec![Listener {
                bind_host: "127.0.0.1".into(),
                port: 22,
                pid: Some(8),
            }];
            if !self.stopped.load(Ordering::SeqCst) {
                out.push(Listener {
                    bind_host: "127.0.0.1".into(),
                    port: 5173,
                    pid: Some(7),
                });
            }
            Ok(out)
        }
        fn processes(&self) -> Result<Vec<Proc>, ScanError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(vec![Proc {
                pid: 7,
                ppid: None,
                name: "node".into(),
                cmd: "node".into(),
                cwd: Some(PathBuf::from("/w/a")),
                start: None,
            }])
        }
        fn terminate(&self, pid: u32) -> Result<(), ScanError> {
            if pid == 7 {
                self.stopped.store(true, Ordering::SeqCst);
            }
            Ok(())
        }
        fn kill(&self, pid: u32) -> Result<(), ScanError> {
            self.terminate(pid)
        }
    }

    fn fixture() -> (Scanner<Fake>, Mutex<AdvertisedUrls>, Vec<PathBuf>) {
        (
            Scanner::new(Fake::default(), Instant::now),
            Mutex::default(),
            vec![PathBuf::from("/w/a")],
        )
    }

    /// A terminal running in `/w/a`; pid 7 is not under it.
    fn terminal() -> [PtyRoot; 1] {
        [PtyRoot {
            pid: 99,
            worktree: PathBuf::from("/w/a"),
        }]
    }

    #[test]
    fn makes_no_call_when_no_worktree_has_a_terminal() {
        let (scanner, urls, wts) = fixture();
        let elsewhere = [PtyRoot {
            pid: 99,
            worktree: PathBuf::from("/w/other"),
        }];
        for roots in [&[][..], &elsewhere[..]] {
            let scan = scan_in(&scanner, &urls, roots, &wts, true);
            assert!(scan.ports.is_empty());
            assert_eq!(scan.unavailable.as_deref(), Some("no_terminal"));
        }
        assert_eq!(scanner.probe().calls.load(Ordering::SeqCst), 0);
        let scan = scan_in(&scanner, &urls, &terminal(), &wts, true);
        assert_eq!(scan.ports.len(), 2);
        assert!(scanner.probe().calls.load(Ordering::SeqCst) > 0);
    }

    #[test]
    fn a_scan_lists_the_ports_and_remembers_them_for_open() {
        let (scanner, urls, wts) = fixture();
        let scan = scan_in(&scanner, &urls, &terminal(), &wts, false);
        assert_eq!(scan.ports.len(), 2);
        let url = open_target_in(&scanner, "127.0.0.1:5173:7");
        assert_eq!(url.as_deref().ok(), Some("http://127.0.0.1:5173"));
    }

    #[test]
    fn open_refuses_an_id_that_no_scan_listed() {
        let (scanner, urls, wts) = fixture();
        let before = open_target_in(&scanner, "127.0.0.1:5173:7");
        assert_eq!(before.unwrap_err().code, "port_gone");
        scan_in(&scanner, &urls, &terminal(), &wts, false);
        let other = open_target_in(&scanner, "localhost:9:9");
        assert_eq!(other.unwrap_err().code, "port_gone");
    }

    const TWICE: StopConsent = StopConsent {
        confirmed: true,
        outside_terminal: true,
    };

    #[test]
    fn stop_maps_each_refusal_to_its_code() {
        let (scanner, urls, wts) = fixture();
        let code = |id: &str, consent: StopConsent, protected: &[u32]| {
            stop_in(&scanner, &urls, &[], &wts, id, consent, protected)
                .unwrap_err()
                .code
        };
        let id = "127.0.0.1:5173:7";
        assert_eq!(
            code(id, StopConsent::default(), &[]),
            "port_stop_unconfirmed"
        );
        let once = StopConsent {
            confirmed: true,
            outside_terminal: false,
        };
        // Pid 7 only works in the worktree's folder: no xDev terminal started it.
        assert_eq!(code(id, once, &[]), "port_not_started_by_app");
        assert_eq!(code("localhost:1:1", TWICE, &[]), "port_gone");
        assert_eq!(code("127.0.0.1:22:8", TWICE, &[]), "port_not_owned");
        assert_eq!(code(id, TWICE, &[7]), "port_own_process");
        assert!(stop_in(&scanner, &urls, &[], &wts, id, TWICE, &[]).is_ok());
    }

    #[test]
    fn one_confirmation_stops_a_listener_under_an_xdev_terminal() {
        let (scanner, urls, wts) = fixture();
        let roots = [PtyRoot {
            pid: 7,
            worktree: PathBuf::from("/w/a"),
        }];
        let once = StopConsent {
            confirmed: true,
            outside_terminal: false,
        };
        assert!(stop_in(&scanner, &urls, &roots, &wts, "127.0.0.1:5173:7", once, &[]).is_ok());
    }

    #[test]
    fn a_new_origin_is_announced_once_per_second_per_worktree() {
        let ports = Ports::default();
        let w = Path::new("/w/a");
        let t0 = Instant::now();
        let said = ports.feed_at(t0, "p", w, b"http://localhost:3000\n");
        assert_eq!(said.as_deref(), Some("/w/a"));
        // A second origin inside the gap is kept, but not announced.
        let at = t0 + Duration::from_millis(500);
        assert_eq!(ports.feed_at(at, "p", w, b"http://localhost:3001\n"), None);
        // The same origin again is not new.
        let later = t0 + Duration::from_secs(3);
        assert_eq!(
            ports.feed_at(later, "p", w, b"http://localhost:3000\n"),
            None
        );
        let again = ports.feed_at(later, "p", w, b"http://localhost:3002\n");
        assert_eq!(again.as_deref(), Some("/w/a"));
    }

    #[test]
    fn forgetting_a_terminal_drops_its_origins() {
        let ports = Ports::default();
        let w = Path::new("/w/a");
        ports.feed("p", w, b"http://localhost:3000\n");
        assert!(ports.urls.lock().unwrap().lookup(w, 3000).is_some());
        ports.forget_pty("p");
        assert!(ports.urls.lock().unwrap().lookup(w, 3000).is_none());
    }
}
