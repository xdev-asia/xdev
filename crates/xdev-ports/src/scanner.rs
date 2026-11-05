//! One scan at a time, with a time limit and a back-off after a timeout.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::attribute::attribute;
use crate::urls::AdvertisedUrls;
use crate::{
    Listener, PortEvidence, PortKind, PortScan, Probe, Proc, PtyRoot, ScanError, WorkspacePort,
};

/// How long one command may run.
pub const SCAN_TIMEOUT: Duration = Duration::from_secs(4);
/// The first pause after a timeout.
/// How long a stopped tree has to close its port, once after TERM and once
/// more after KILL.
pub const STOP_GRACE: Duration = Duration::from_secs(2);
/// How often the port is read while waiting for it to close.
const STOP_POLL: Duration = Duration::from_millis(100);
const PAUSE_FIRST: Duration = Duration::from_secs(60);
/// The longest pause.
const PAUSE_MAX: Duration = Duration::from_secs(300);

/// What the person agreed to when asking for a stop.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StopConsent {
    /// They confirmed the stop. Nothing is read or signalled without it.
    pub confirmed: bool,
    /// They confirmed a second time that a port no xDev terminal started
    /// (matched by working folder or command line only) may be stopped.
    pub outside_terminal: bool,
}

/// Why a stop was refused or failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum StopError {
    #[error("the port is no longer listening")]
    Gone,
    #[error("the port does not belong to a worktree")]
    NotOwned,
    #[error("the port has no known process")]
    NoPid,
    #[error("the stop was not confirmed")]
    NotConfirmed,
    /// Matched to a worktree by folder or command only, without the second
    /// confirmation.
    #[error("the port was not started by an xDev terminal")]
    NotStartedByApp,
    #[error("the port belongs to this app")]
    OwnProcess,
    /// No fresh list: the last one may name a pid the OS has since reused.
    #[error("the port list is not fresh")]
    Unavailable,
    /// The process on the port is not the one the list showed.
    #[error("the process on the port changed")]
    Changed,
    /// The tree was told to end, but the port still had a listener after
    /// the grace time and a hard kill.
    #[error("the port is still listening")]
    StillListening,
    #[error("{0}")]
    Failed(String),
}

impl StopError {
    /// The code the webview maps to a message.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Gone => "port_gone",
            Self::NotOwned => "port_not_owned",
            Self::NoPid => "port_no_pid",
            Self::NotConfirmed => "port_stop_unconfirmed",
            Self::NotStartedByApp => "port_not_started_by_app",
            Self::OwnProcess => "port_own_process",
            Self::Unavailable => "port_scan_unavailable",
            Self::Changed => "port_changed",
            Self::StillListening => "port_still_listening",
            Self::Failed(_) => "stop_failed",
        }
    }
}

/// What tells one process apart from a later one with the same pid.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Identity {
    name: String,
    start: Option<u64>,
}

impl Identity {
    fn of(proc: &Proc) -> Self {
        Self {
            name: proc.name.clone(),
            start: proc.start,
        }
    }
}

#[derive(Default)]
struct State {
    /// Bumped by every finished scan, so a waiter can tell one ran meanwhile.
    generation: u64,
    last: Option<PortScan>,
    /// The last scan that listed ports.
    good: Option<Vec<WorkspacePort>>,
    /// Name and start of each listed pid in the last good scan.
    seen: HashMap<u32, Identity>,
    failures: u32,
    pause_until: Option<Instant>,
    pause: Duration,
}

/// Scans through a `Probe`. Scans never overlap: one that arrives while
/// another runs waits and takes its result.
pub struct Scanner<P: Probe> {
    probe: P,
    clock: fn() -> Instant,
    state: Mutex<State>,
    running: Mutex<()>,
    grace: Duration,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

impl PortScan {
    /// The answer, without reading the OS, when no queried worktree runs a
    /// terminal xDev started.
    pub fn no_terminal() -> Self {
        Self {
            platform: platform().into(),
            scanned_at: now_ms(),
            ports: Vec::new(),
            unavailable: Some("no_terminal".into()),
            detail: None,
            retry_in: None,
        }
    }
}

impl<P: Probe> Scanner<P> {
    pub fn new(probe: P, clock: fn() -> Instant) -> Self {
        Self {
            probe,
            clock,
            state: Mutex::new(State::default()),
            running: Mutex::new(()),
            grace: STOP_GRACE,
        }
    }

    /// The same scanner with another wait for a stopped port to close.
    pub fn with_grace(mut self, grace: Duration) -> Self {
        self.grace = grace;
        self
    }

    pub fn probe(&self) -> &P {
        &self.probe
    }

    /// The result of the last scan, if any.
    pub fn last(&self) -> Option<PortScan> {
        self.state.lock().ok()?.last.clone()
    }

    /// Scans now. A pause after a timeout holds even for `force`.
    pub fn scan(
        &self,
        roots: &[PtyRoot],
        worktrees: &[PathBuf],
        urls: &Mutex<AdvertisedUrls>,
        _force: bool,
    ) -> PortScan {
        let before = self.state.lock().map_or(0, |s| s.generation);
        let _turn = self.running.lock().unwrap_or_else(|e| e.into_inner());
        {
            let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.generation != before
                && let Some(last) = &state.last
            {
                return last.clone();
            }
        }
        let scan = self.run(roots, worktrees, urls);
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.generation += 1;
        state.last = Some(scan.clone());
        scan
    }

    fn run(
        &self,
        roots: &[PtyRoot],
        worktrees: &[PathBuf],
        urls: &Mutex<AdvertisedUrls>,
    ) -> PortScan {
        let now = (self.clock)();
        let paused = {
            let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state
                .pause_until
                .filter(|until| now < *until)
                .map(|until| until - now)
        };
        if let Some(left) = paused {
            let secs = left.as_secs() + u64::from(left.subsec_nanos() > 0);
            return self.failed(ScanError::Timeout, Some(secs as u32), false);
        }
        let found = self
            .probe
            .listeners(SCAN_TIMEOUT)
            .and_then(|listeners| Ok((listeners, self.probe.processes()?)));
        match found {
            Ok((listeners, procs)) => {
                let ports = attribute(&listeners, &procs, roots, worktrees, &|w, p| {
                    urls.lock().ok().and_then(|u| u.lookup(w, p))
                });
                let listening: Vec<_> = ports
                    .iter()
                    .filter(|p| p.kind == PortKind::Workspace)
                    .filter_map(|p| Some((PathBuf::from(p.worktree.as_ref()?), p.port, p.pid)))
                    .collect();
                if let Ok(mut u) = urls.lock() {
                    u.reconcile(&listening);
                }
                let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                state.failures = 0;
                state.pause_until = None;
                state.pause = Duration::ZERO;
                state.good = Some(ports.clone());
                state.seen = procs
                    .iter()
                    .filter(|p| ports.iter().any(|port| port.pid == Some(p.pid)))
                    .map(|p| (p.pid, Identity::of(p)))
                    .collect();
                PortScan {
                    platform: platform().into(),
                    scanned_at: now_ms(),
                    ports,
                    unavailable: None,
                    detail: None,
                    retry_in: None,
                }
            }
            Err(error) => self.failed(error, None, true),
        }
    }

    /// The result of a scan that gave no fresh list. The first failure keeps
    /// the last good list; the second replaces it with an empty one.
    fn failed(&self, error: ScanError, retry_in: Option<u32>, count: bool) -> PortScan {
        let now = (self.clock)();
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if count {
            state.failures += 1;
        }
        let mut retry = retry_in;
        if count && error == ScanError::Timeout {
            let next = if state.pause.is_zero() {
                PAUSE_FIRST
            } else {
                (state.pause * 2).min(PAUSE_MAX)
            };
            state.pause = next;
            state.pause_until = Some(now + next);
            retry = Some(next.as_secs() as u32);
        }
        let ports = if state.failures <= 1 {
            state.good.clone().unwrap_or_default()
        } else {
            state.good = None;
            Vec::new()
        };
        let (code, detail) = match &error {
            ScanError::Timeout => ("scan_timeout", None),
            ScanError::Failed(why) => ("scan_failed", Some(why.clone())),
            ScanError::Unsupported => ("unsupported", None),
        };
        PortScan {
            platform: platform().into(),
            scanned_at: now_ms(),
            ports,
            unavailable: Some(code.into()),
            detail,
            retry_in: retry,
        }
    }

    /// Ends the process behind port `id`, once `consent` confirms it. Only a
    /// listener under a terminal xDev started in that worktree is stopped,
    /// unless `consent.outside_terminal`. Refuses unless a fresh scan lists
    /// it, then reads the live tables once more right before the signal: the
    /// pid must still exist, still listen on that port, and keep the name and
    /// start time the scan saw, so a reused pid is never hit. `protected`
    /// pids are refused.
    ///
    /// The tree under the pid is read once, as (pid, start time), before any
    /// signal. Each of its pids gets TERM; when the port is still open after
    /// the grace time, KILL goes only to the pids that still have the start
    /// time the read saw, and not at all where TERM already was the hard
    /// stop (Windows). Succeeds only once a read of the live table shows
    /// nothing listening on the port, and returns the list after it.
    pub fn stop(
        &self,
        id: &str,
        consent: StopConsent,
        roots: &[PtyRoot],
        worktrees: &[PathBuf],
        urls: &Mutex<AdvertisedUrls>,
        protected: &[u32],
    ) -> Result<PortScan, StopError> {
        if !consent.confirmed {
            return Err(StopError::NotConfirmed);
        }
        let scan = self.scan(roots, worktrees, urls, true);
        if scan.unavailable.is_some() {
            return Err(StopError::Unavailable);
        }
        let port = scan
            .ports
            .iter()
            .find(|p| p.id == id)
            .ok_or(StopError::Gone)?;
        if port.kind != PortKind::Workspace {
            return Err(StopError::NotOwned);
        }
        if port.evidence != Some(PortEvidence::Terminal) && !consent.outside_terminal {
            return Err(StopError::NotStartedByApp);
        }
        let pid = port.pid.ok_or(StopError::NoPid)?;
        if protected.contains(&pid) {
            return Err(StopError::OwnProcess);
        }
        let seen = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .seen
            .get(&pid)
            .cloned()
            .ok_or(StopError::Changed)?;
        let live = self.still_the_same(pid, port.port, &seen)?;
        // The tree as it stands before any signal: a child whose parent ends is
        // moved under another parent and could not be found from the pid after.
        let tree: Vec<(u32, Identity)> = tree_of(pid, &live)
            .into_iter()
            .filter(|p| !protected.contains(&p.pid))
            .map(|p| (p.pid, Identity::of(p)))
            .collect();
        let number = port.port;
        let mut failed = None;
        for (at, (p, _)) in tree.iter().enumerate() {
            match self.probe.terminate(*p) {
                Ok(()) => {}
                // The listener itself: nothing was signalled yet.
                Err(e) if at == 0 => return Err(StopError::Failed(e.to_string())),
                Err(e) => {
                    failed.get_or_insert(e.to_string());
                }
            }
        }
        if !self.closes(number) {
            // Where TERM already was the hard stop, a second one could only
            // hit a pid the OS gave to someone else since.
            if !self.probe.terminate_is_final() {
                let now = self.probe.processes().map_err(|_| StopError::Unavailable)?;
                for (p, was) in &tree {
                    if same_process(*p, was, &now)
                        && let Err(e) = self.probe.kill(*p)
                    {
                        failed.get_or_insert(e.to_string());
                    }
                }
            }
            if !self.closes(number) {
                return Err(failed.map_or(StopError::StillListening, StopError::Failed));
            }
        }
        Ok(self.scan(roots, worktrees, urls, true))
    }

    /// Whether nothing listens on `port` within the grace time. A failed read
    /// proves nothing, so it waits on.
    fn closes(&self, port: u16) -> bool {
        let end = Instant::now() + self.grace;
        loop {
            if let Ok(listeners) = self.probe.listeners(SCAN_TIMEOUT)
                && !listeners.iter().any(|l| l.port == port)
            {
                return true;
            }
            let left = end.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            std::thread::sleep(left.min(STOP_POLL));
        }
    }

    /// Reads the live tables: `pid` still runs as `seen` and listens on `port`.
    /// Returns the process table it read.
    fn still_the_same(&self, pid: u32, port: u16, seen: &Identity) -> Result<Vec<Proc>, StopError> {
        let listeners: Vec<Listener> = self
            .probe
            .listeners(SCAN_TIMEOUT)
            .map_err(|_| StopError::Unavailable)?;
        if !listeners
            .iter()
            .any(|l| l.port == port && l.pid == Some(pid))
        {
            return Err(StopError::Changed);
        }
        let procs = self.probe.processes().map_err(|_| StopError::Unavailable)?;
        match procs.iter().find(|p| p.pid == pid) {
            Some(now) if Identity::of(now) == *seen => Ok(procs),
            _ => Err(StopError::Changed),
        }
    }
}

/// Whether `pid` in `procs` is still the process `was` describes. An unknown
/// start time cannot tell a reused pid apart, so it never matches.
fn same_process(pid: u32, was: &Identity, procs: &[Proc]) -> bool {
    was.start.is_some()
        && procs
            .iter()
            .any(|p| p.pid == pid && Identity::of(p) == *was)
}

/// `pid` and every process under it in `procs`, parents before children,
/// through the links `Proc::is_parent_of` accepts.
fn tree_of(pid: u32, procs: &[Proc]) -> Vec<&Proc> {
    let Some(top) = procs.iter().find(|p| p.pid == pid) else {
        return Vec::new();
    };
    let mut out = vec![top];
    let mut i = 0;
    while i < out.len() {
        let parent = out[i];
        for p in procs {
            if parent.is_parent_of(p) && !out.iter().any(|o| o.pid == p.pid) {
                out.push(p);
            }
        }
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, OnceLock};

    use super::*;
    use crate::{Listener, Proc};

    thread_local! {
        static OFFSET: Cell<u64> = const { Cell::new(0) };
    }

    fn base() -> Instant {
        static BASE: OnceLock<Instant> = OnceLock::new();
        *BASE.get_or_init(Instant::now)
    }

    fn clock() -> Instant {
        base() + Duration::from_secs(OFFSET.with(Cell::get))
    }

    fn advance(secs: u64) {
        OFFSET.with(|o| o.set(o.get() + secs));
    }

    type Queue = Arc<Mutex<Vec<Result<Vec<Listener>, ScanError>>>>;

    #[derive(Clone, Default)]
    struct Fake {
        listeners: Queue,
        calls: Arc<AtomicUsize>,
        killed: Arc<Mutex<Vec<u32>>>,
        procs: Arc<Mutex<Vec<Proc>>>,
        /// From the second process read on, when set: the table changed.
        later: Arc<Mutex<Option<Vec<Proc>>>>,
        proc_calls: Arc<AtomicUsize>,
        /// Pids given a hard kill.
        hard: Arc<Mutex<Vec<u32>>>,
        /// 0 ends on TERM, 1 only on KILL, 2 never.
        stubborn: Arc<AtomicUsize>,
        /// Pids that ignore TERM whatever `stubborn` says.
        deaf: Arc<Mutex<Vec<u32>>>,
        /// The process table from the first TERM on, when set.
        after_term: Arc<Mutex<Option<Vec<Proc>>>>,
        /// TERM is already the hard stop, as on Windows.
        forced: Arc<AtomicBool>,
    }

    impl Fake {
        fn queue(&self, r: Result<Vec<Listener>, ScanError>) {
            self.listeners.lock().unwrap().push(r);
        }

        /// The process ends: its sockets leave every queued table.
        fn end(&self, pid: u32) {
            for table in self.listeners.lock().unwrap().iter_mut().flatten() {
                table.retain(|l| l.pid != Some(pid));
            }
        }
    }

    impl Probe for Fake {
        fn listeners(&self, _t: Duration) -> Result<Vec<Listener>, ScanError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let mut q = self.listeners.lock().unwrap();
            if q.len() > 1 {
                q.remove(0)
            } else {
                q.first().cloned().unwrap_or(Ok(Vec::new()))
            }
        }
        fn processes(&self) -> Result<Vec<Proc>, ScanError> {
            let n = self.proc_calls.fetch_add(1, Ordering::SeqCst);
            if n >= 1
                && let Some(later) = self.later.lock().unwrap().clone()
            {
                return Ok(later);
            }
            Ok(self.procs.lock().unwrap().clone())
        }
        fn terminate(&self, pid: u32) -> Result<(), ScanError> {
            self.killed.lock().unwrap().push(pid);
            if let Some(table) = self.after_term.lock().unwrap().take() {
                *self.procs.lock().unwrap() = table;
                *self.later.lock().unwrap() = None;
            }
            if self.stubborn.load(Ordering::SeqCst) == 0
                && !self.deaf.lock().unwrap().contains(&pid)
            {
                self.end(pid);
            }
            Ok(())
        }
        fn terminate_is_final(&self) -> bool {
            self.forced.load(Ordering::SeqCst)
        }
        fn kill(&self, pid: u32) -> Result<(), ScanError> {
            self.hard.lock().unwrap().push(pid);
            if self.stubborn.load(Ordering::SeqCst) <= 1 {
                self.end(pid);
            }
            Ok(())
        }
    }

    fn listen(port: u16, pid: u32) -> Listener {
        Listener {
            bind_host: "127.0.0.1".into(),
            port,
            pid: Some(pid),
        }
    }

    fn proc(pid: u32, cwd: &str) -> Proc {
        Proc {
            pid,
            ppid: None,
            name: "node".into(),
            cmd: "node".into(),
            cwd: Some(PathBuf::from(cwd)),
            start: Some(1_000),
        }
    }

    /// Confirmed twice: the cwd-matched ports these tests use may be stopped.
    const YES: StopConsent = StopConsent {
        confirmed: true,
        outside_terminal: true,
    };

    fn root(pid: u32) -> PtyRoot {
        PtyRoot {
            pid,
            worktree: PathBuf::from("/w/a"),
        }
    }

    fn setup() -> (Scanner<Fake>, Fake, Mutex<AdvertisedUrls>, Vec<PathBuf>) {
        OFFSET.with(|o| o.set(0));
        let fake = Fake::default();
        let scanner = Scanner::new(fake.clone(), clock).with_grace(Duration::from_millis(50));
        (
            scanner,
            fake,
            Mutex::new(AdvertisedUrls::default()),
            vec![PathBuf::from("/w/a")],
        )
    }

    #[test]
    fn a_good_scan_lists_the_ports_of_a_worktree() {
        let (s, f, urls, wts) = setup();
        f.queue(Ok(vec![listen(5173, 7)]));
        *f.procs.lock().unwrap() = vec![proc(7, "/w/a/app")];
        let scan = s.scan(&[], &wts, &urls, false);
        assert_eq!(scan.unavailable, None);
        assert_eq!(scan.ports.len(), 1);
        assert_eq!(scan.ports[0].kind, PortKind::Workspace);
    }

    #[test]
    fn timeouts_back_off_60_120_240_then_300_seconds() {
        let (s, f, urls, wts) = setup();
        f.queue(Err(ScanError::Timeout));
        let mut seen = Vec::new();
        for _ in 0..5 {
            let scan = s.scan(&[], &wts, &urls, false);
            assert_eq!(scan.unavailable.as_deref(), Some("scan_timeout"));
            seen.push(scan.retry_in.unwrap());
            advance(u64::from(scan.retry_in.unwrap()));
        }
        assert_eq!(seen, vec![60, 120, 240, 300, 300]);
    }

    #[test]
    fn a_scan_during_the_pause_does_not_reach_the_probe() {
        let (s, f, urls, wts) = setup();
        f.queue(Err(ScanError::Timeout));
        s.scan(&[], &wts, &urls, false);
        assert_eq!(f.calls.load(Ordering::SeqCst), 1);
        advance(10);
        let scan = s.scan(&[], &wts, &urls, true);
        assert_eq!(f.calls.load(Ordering::SeqCst), 1);
        assert_eq!(scan.unavailable.as_deref(), Some("scan_timeout"));
        assert_eq!(scan.retry_in, Some(50));
    }

    #[test]
    fn a_success_resets_the_back_off() {
        let (s, f, urls, wts) = setup();
        f.queue(Err(ScanError::Timeout));
        f.queue(Ok(vec![]));
        f.queue(Err(ScanError::Timeout));
        s.scan(&[], &wts, &urls, false);
        advance(60);
        assert_eq!(s.scan(&[], &wts, &urls, false).unavailable, None);
        let again = s.scan(&[], &wts, &urls, false);
        assert_eq!(again.retry_in, Some(60));
    }

    #[test]
    fn the_last_good_list_survives_one_failure_and_not_two() {
        let (s, f, urls, wts) = setup();
        f.queue(Ok(vec![listen(5173, 7)]));
        *f.procs.lock().unwrap() = vec![proc(7, "/w/a")];
        f.queue(Err(ScanError::Failed("boom".into())));
        assert_eq!(s.scan(&[], &wts, &urls, false).ports.len(), 1);
        let first = s.scan(&[], &wts, &urls, false);
        assert_eq!(first.unavailable.as_deref(), Some("scan_failed"));
        assert_eq!(first.detail.as_deref(), Some("boom"));
        assert_eq!(first.ports.len(), 1);
        let second = s.scan(&[], &wts, &urls, false);
        assert!(second.ports.is_empty());
    }

    #[test]
    fn an_unsupported_platform_says_so() {
        let (s, f, urls, wts) = setup();
        f.queue(Err(ScanError::Unsupported));
        let scan = s.scan(&[], &wts, &urls, false);
        assert_eq!(scan.unavailable.as_deref(), Some("unsupported"));
    }

    #[test]
    fn scans_that_overlap_share_one_probe_run() {
        let (s, f, urls, wts) = setup();
        f.queue(Ok(vec![]));
        let s = Arc::new(s);
        let urls = Arc::new(urls);
        let wts = Arc::new(wts);
        let run = |s: Arc<Scanner<Fake>>, u: Arc<Mutex<AdvertisedUrls>>, w: Arc<Vec<PathBuf>>| {
            std::thread::spawn(move || s.scan(&[], &w, &u, false))
        };
        // Hold the turn so both callers queue behind a running scan.
        let turn = s.running.lock().unwrap();
        let a = run(s.clone(), urls.clone(), wts.clone());
        let b = run(s.clone(), urls.clone(), wts.clone());
        std::thread::sleep(Duration::from_millis(200));
        // A third scan "finishes" meanwhile: both waiters took their ticket before it.
        s.state.lock().unwrap().generation += 1;
        s.state.lock().unwrap().last = Some(PortScan {
            platform: "x".into(),
            scanned_at: 1,
            ports: vec![],
            unavailable: None,
            detail: None,
            retry_in: None,
        });
        drop(turn);
        assert_eq!(a.join().unwrap().platform, "x");
        assert_eq!(b.join().unwrap().platform, "x");
        assert_eq!(f.calls.load(Ordering::SeqCst), 0);
    }

    fn with_port(kind_cwd: &str) -> (Scanner<Fake>, Fake, Mutex<AdvertisedUrls>, Vec<PathBuf>) {
        let (s, f, urls, wts) = setup();
        f.queue(Ok(vec![listen(5173, 7)]));
        *f.procs.lock().unwrap() = vec![proc(7, kind_cwd)];
        (s, f, urls, wts)
    }

    #[test]
    fn stop_ends_a_workspace_process_once_and_rescans() {
        let (s, f, urls, wts) = with_port("/w/a");
        let id = "127.0.0.1:5173:7";
        s.stop(id, YES, &[], &wts, &urls, &[]).unwrap();
        assert_eq!(*f.killed.lock().unwrap(), vec![7]);
    }

    #[test]
    fn stop_refuses_a_port_that_is_gone() {
        let (s, f, urls, wts) = with_port("/w/a");
        let err = s
            .stop("localhost:1:2", YES, &[], &wts, &urls, &[])
            .unwrap_err();
        assert_eq!(err, StopError::Gone);
        assert_eq!(err.code(), "port_gone");
        assert!(f.killed.lock().unwrap().is_empty());
    }

    #[test]
    fn stop_refuses_a_port_no_worktree_owns() {
        let (s, f, urls, wts) = with_port("/elsewhere");
        let err = s
            .stop("127.0.0.1:5173:7", YES, &[], &wts, &urls, &[])
            .unwrap_err();
        assert_eq!(err, StopError::NotOwned);
        assert!(f.killed.lock().unwrap().is_empty());
    }

    #[test]
    fn stop_refuses_a_port_without_a_pid() {
        let (s, f, urls, wts) = setup();
        f.queue(Ok(vec![Listener {
            bind_host: "127.0.0.1".into(),
            port: 9,
            pid: None,
        }]));
        let err = s
            .stop("127.0.0.1:9:unknown", YES, &[], &wts, &urls, &[])
            .unwrap_err();
        // No pid also means no owner here, so the owner check speaks first.
        assert!(matches!(err, StopError::NotOwned | StopError::NoPid));
        assert!(f.killed.lock().unwrap().is_empty());
    }

    #[test]
    fn stop_refuses_the_apps_own_process() {
        let (s, f, urls, wts) = with_port("/w/a");
        let err = s
            .stop("127.0.0.1:5173:7", YES, &[], &wts, &urls, &[7])
            .unwrap_err();
        assert_eq!(err, StopError::OwnProcess);
        assert_eq!(err.code(), "port_own_process");
        assert!(f.killed.lock().unwrap().is_empty());
    }

    #[test]
    fn stop_during_a_back_off_pause_is_refused_without_a_signal() {
        let (s, f, urls, wts) = with_port("/w/a");
        assert_eq!(s.scan(&[], &wts, &urls, false).ports.len(), 1);
        // A timeout starts the pause; the scan then returns the last good list.
        f.queue(Err(ScanError::Timeout));
        let _ = f.listeners.lock().unwrap().remove(0);
        let paused = s.scan(&[], &wts, &urls, false);
        assert_eq!(paused.unavailable.as_deref(), Some("scan_timeout"));
        assert_eq!(paused.ports.len(), 1, "the stale list is still shown");
        advance(10);
        let calls = f.calls.load(Ordering::SeqCst);
        let err = s
            .stop("127.0.0.1:5173:7", YES, &[], &wts, &urls, &[])
            .unwrap_err();
        assert_eq!(err, StopError::Unavailable);
        assert_eq!(err.code(), "port_scan_unavailable");
        assert!(f.killed.lock().unwrap().is_empty());
        assert_eq!(
            f.calls.load(Ordering::SeqCst),
            calls,
            "no OS read in the pause"
        );
    }

    #[test]
    fn stop_refuses_a_pid_that_now_names_another_process() {
        let (s, f, urls, wts) = with_port("/w/a");
        // Between the scan and the signal the pid ends and is reused.
        let mut reused = proc(7, "/w/a");
        reused.name = "postgres".into();
        reused.start = Some(2_000);
        *f.later.lock().unwrap() = Some(vec![reused]);
        let err = s
            .stop("127.0.0.1:5173:7", YES, &[], &wts, &urls, &[])
            .unwrap_err();
        assert_eq!(err, StopError::Changed);
        assert_eq!(err.code(), "port_changed");
        assert!(f.killed.lock().unwrap().is_empty());
    }

    #[test]
    fn stop_refuses_a_pid_with_the_same_name_but_a_new_start() {
        let (s, f, urls, wts) = with_port("/w/a");
        let mut again = proc(7, "/w/a");
        again.start = Some(1_001);
        *f.later.lock().unwrap() = Some(vec![again]);
        let err = s
            .stop("127.0.0.1:5173:7", YES, &[], &wts, &urls, &[])
            .unwrap_err();
        assert_eq!(err, StopError::Changed);
        assert!(f.killed.lock().unwrap().is_empty());
    }

    #[test]
    fn stop_refuses_a_pid_that_no_longer_listens_on_the_port() {
        let (s, f, urls, wts) = with_port("/w/a");
        // The scan sees 5173 on pid 7; the check right after sees it on pid 9.
        f.queue(Ok(vec![listen(5173, 9)]));
        let err = s
            .stop("127.0.0.1:5173:7", YES, &[], &wts, &urls, &[])
            .unwrap_err();
        assert_eq!(err, StopError::Changed);
        assert!(f.killed.lock().unwrap().is_empty());
    }

    #[test]
    fn stop_without_confirmation_reads_and_signals_nothing() {
        let (s, f, urls, wts) = with_port("/w/a");
        let err = s
            .stop(
                "127.0.0.1:5173:7",
                StopConsent::default(),
                &[root(7)],
                &wts,
                &urls,
                &[],
            )
            .unwrap_err();
        assert_eq!(err, StopError::NotConfirmed);
        assert_eq!(err.code(), "port_stop_unconfirmed");
        assert_eq!(f.calls.load(Ordering::SeqCst), 0);
        assert!(f.killed.lock().unwrap().is_empty());
    }

    #[test]
    fn stop_ends_a_listener_under_an_xdev_terminal_with_one_confirmation() {
        let (s, f, urls, wts) = with_port("/elsewhere");
        let once = StopConsent {
            confirmed: true,
            outside_terminal: false,
        };
        let after = s
            .stop("127.0.0.1:5173:7", once, &[root(7)], &wts, &urls, &[])
            .unwrap();
        assert_eq!(*f.killed.lock().unwrap(), vec![7]);
        // TERM closed the port, so there was no hard kill.
        assert!(f.hard.lock().unwrap().is_empty());
        assert!(after.ports.iter().all(|p| p.port != 5173));
    }

    #[test]
    fn a_tree_that_ignores_term_gets_a_kill_after_the_grace() {
        let (s, f, urls, wts) = with_port("/w/a");
        f.stubborn.store(1, Ordering::SeqCst);
        let after = s
            .stop("127.0.0.1:5173:7", YES, &[root(7)], &wts, &urls, &[])
            .unwrap();
        assert_eq!(*f.killed.lock().unwrap(), vec![7]);
        assert_eq!(*f.hard.lock().unwrap(), vec![7]);
        assert!(after.ports.iter().all(|p| p.port != 5173));
    }

    #[test]
    fn a_port_still_open_after_the_kill_is_not_reported_stopped() {
        let (s, f, urls, wts) = with_port("/w/a");
        f.stubborn.store(2, Ordering::SeqCst);
        let err = s
            .stop("127.0.0.1:5173:7", YES, &[root(7)], &wts, &urls, &[])
            .unwrap_err();
        assert_eq!(err, StopError::StillListening);
        assert_eq!(err.code(), "port_still_listening");
        assert_eq!(*f.hard.lock().unwrap(), vec![7]);
    }

    #[test]
    fn a_port_matched_by_folder_only_needs_the_second_confirmation() {
        let (s, f, urls, wts) = with_port("/w/a");
        let once = StopConsent {
            confirmed: true,
            outside_terminal: false,
        };
        let err = s
            .stop("127.0.0.1:5173:7", once, &[], &wts, &urls, &[])
            .unwrap_err();
        assert_eq!(err, StopError::NotStartedByApp);
        assert_eq!(err.code(), "port_not_started_by_app");
        assert!(f.killed.lock().unwrap().is_empty());
        s.stop("127.0.0.1:5173:7", YES, &[], &wts, &urls, &[])
            .unwrap();
        assert_eq!(*f.killed.lock().unwrap(), vec![7]);
    }

    #[test]
    fn a_port_matched_by_command_only_needs_the_second_confirmation() {
        let (s, f, urls, wts) = setup();
        f.queue(Ok(vec![listen(5173, 7)]));
        let mut p = proc(7, "/elsewhere");
        p.cmd = "node /w/a/server.js".into();
        *f.procs.lock().unwrap() = vec![p];
        let once = StopConsent {
            confirmed: true,
            outside_terminal: false,
        };
        let err = s
            .stop("127.0.0.1:5173:7", once, &[], &wts, &urls, &[])
            .unwrap_err();
        assert_eq!(err, StopError::NotStartedByApp);
        assert!(f.killed.lock().unwrap().is_empty());
    }

    fn child(pid: u32, ppid: u32) -> Proc {
        Proc {
            ppid: Some(ppid),
            ..proc(pid, "/w/a")
        }
    }

    #[test]
    fn the_tree_holds_every_descendant_once_and_survives_a_loop() {
        let p = |pid: u32, ppid: Option<u32>| Proc {
            ppid,
            ..proc(pid, "/")
        };
        let procs = [
            p(1, None),
            p(10, Some(1)),
            p(11, Some(10)),
            p(12, Some(10)),
            p(13, Some(12)),
            p(20, Some(1)),
            // A loop must not hang the walk.
            p(30, Some(31)),
            p(31, Some(30)),
        ];
        let pids = |pid| {
            tree_of(pid, &procs)
                .iter()
                .map(|p| p.pid)
                .collect::<Vec<_>>()
        };
        assert_eq!(pids(10), vec![10, 11, 12, 13]);
        assert_eq!(pids(30), vec![30, 31]);
        assert!(pids(99).is_empty());
    }

    #[test]
    fn stop_signals_the_whole_tree_read_before_the_first_signal() {
        let (s, f, urls, wts) = with_port("/w/a");
        f.procs
            .lock()
            .unwrap()
            .extend([child(8, 7), child(9, 8), proc(10, "/w/a")]);
        s.stop("127.0.0.1:5173:7", YES, &[], &wts, &urls, &[])
            .unwrap();
        assert_eq!(*f.killed.lock().unwrap(), vec![7, 8, 9]);
    }

    #[test]
    fn a_child_link_to_a_reused_parent_pid_is_not_followed() {
        let (s, f, urls, wts) = with_port("/w/a");
        // 8 names 7 as parent but started before it: its parent was another
        // process that ended before 7 took the pid.
        let mut stale = child(8, 7);
        stale.start = Some(500);
        f.procs.lock().unwrap().extend([stale, child(9, 8)]);
        s.stop("127.0.0.1:5173:7", YES, &[], &wts, &urls, &[])
            .unwrap();
        assert_eq!(*f.killed.lock().unwrap(), vec![7]);
    }

    #[test]
    fn kill_skips_a_pid_of_the_tree_that_was_reused_meanwhile() {
        let (s, f, urls, wts) = with_port("/w/a");
        f.procs.lock().unwrap().push(child(8, 7));
        f.stubborn.store(1, Ordering::SeqCst);
        // After TERM, pid 8 ended and an unrelated process took the pid.
        let mut reused = proc(8, "/elsewhere");
        reused.name = "postgres".into();
        reused.start = Some(5_000);
        *f.after_term.lock().unwrap() = Some(vec![proc(7, "/w/a"), reused]);
        s.stop("127.0.0.1:5173:7", YES, &[], &wts, &urls, &[])
            .unwrap();
        assert_eq!(*f.killed.lock().unwrap(), vec![7, 8]);
        assert_eq!(*f.hard.lock().unwrap(), vec![7]);
    }

    #[test]
    fn kill_reaches_a_child_that_was_moved_under_init_and_still_listens() {
        let (s, f, urls, wts) = setup();
        // A worker shares the port with the server it was forked from.
        f.queue(Ok(vec![
            listen(5173, 7),
            Listener {
                bind_host: "::1".into(),
                port: 5173,
                pid: Some(8),
            },
        ]));
        *f.procs.lock().unwrap() = vec![proc(7, "/w/a"), child(8, 7)];
        f.deaf.lock().unwrap().push(8);
        // TERM ends the server; the worker now hangs under init.
        *f.after_term.lock().unwrap() = Some(vec![child(8, 1)]);
        s.stop("127.0.0.1:5173:7", YES, &[], &wts, &urls, &[])
            .unwrap();
        assert_eq!(*f.hard.lock().unwrap(), vec![8]);
    }

    #[test]
    fn a_forced_term_is_not_followed_by_a_second_kill() {
        let (s, f, urls, wts) = with_port("/w/a");
        f.forced.store(true, Ordering::SeqCst);
        f.stubborn.store(1, Ordering::SeqCst);
        let err = s
            .stop("127.0.0.1:5173:7", YES, &[], &wts, &urls, &[])
            .unwrap_err();
        assert_eq!(err, StopError::StillListening);
        assert_eq!(*f.killed.lock().unwrap(), vec![7]);
        assert!(f.hard.lock().unwrap().is_empty());
    }

    #[test]
    fn a_protected_pid_in_the_tree_is_never_signalled() {
        let (s, f, urls, wts) = with_port("/w/a");
        f.procs.lock().unwrap().push(child(8, 7));
        s.stop("127.0.0.1:5173:7", YES, &[], &wts, &urls, &[8])
            .unwrap();
        assert_eq!(*f.killed.lock().unwrap(), vec![7]);
    }

    #[test]
    fn stop_codes_cover_every_refusal() {
        assert_eq!(StopError::NotOwned.code(), "port_not_owned");
        assert_eq!(StopError::NoPid.code(), "port_no_pid");
        assert_eq!(StopError::Failed("x".into()).code(), "stop_failed");
    }
}
