//! What an `ssh` run means: the result of a test from its exit code and
//! stderr, the kind of a prompt it asks, and the state of a kept connection.
//! No process here; the caller feeds in what it saw and when.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// How long a kept connection must stay up, with no prompt open, before it
/// counts as connected when `ssh` has not said so itself.
pub const SETTLE: Duration = Duration::from_secs(3);

/// The most stderr a connection keeps for its failure reason.
const STDERR_TAIL: usize = 4096;

/// What a test run found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum SshTestOutcome {
    Ok,
    /// The server wants a password, a passphrase or a key it was not given.
    AuthRequired,
    /// The host key is not in `known_hosts`, or does not match it.
    HostKeyUnknown,
    /// The name did not resolve, or nothing answered.
    Unreachable,
    /// Anything else: the last line `ssh` printed.
    Failed(String),
}

impl SshTestOutcome {
    /// A stable code for a known outcome, else the message: what a failed
    /// connection carries as its reason.
    pub fn reason(&self) -> String {
        match self {
            Self::Ok => "exited".to_owned(),
            Self::AuthRequired => "auth_required".to_owned(),
            Self::HostKeyUnknown => "host_key_unknown".to_owned(),
            Self::Unreachable => "unreachable".to_owned(),
            Self::Failed(m) => m.clone(),
        }
    }
}

fn has_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| haystack.contains(n))
}

/// The last line worth showing: not blank, not a log line of `ssh -v` or
/// `LogLevel=VERBOSE`, at most 200 characters.
fn last_line(stderr: &str) -> Option<String> {
    stderr
        .lines()
        .map(str::trim)
        .rev()
        .find(|l| {
            !l.is_empty()
                && !l.starts_with("debug")
                && !l.starts_with("Authenticated to")
                && !l.starts_with("Warning: Permanently added")
        })
        .map(|l| l.chars().take(200).collect())
}

/// The outcome of an `ssh` run from its exit code (`None` when it was
/// killed) and its stderr. Exit 0 is `Ok`; a killed run is `Unreachable`;
/// else the OpenSSH messages decide.
pub fn classify(exit: Option<i32>, stderr: &str) -> SshTestOutcome {
    if exit == Some(0) {
        return SshTestOutcome::Ok;
    }
    let low = stderr.to_ascii_lowercase();
    if has_any(
        &low,
        &[
            "host key verification failed",
            "remote host identification has changed",
        ],
    ) {
        return SshTestOutcome::HostKeyUnknown;
    }
    if has_any(
        &low,
        &[
            "permission denied",
            "too many authentication failures",
            "no more authentication methods",
            "no supported authentication methods",
        ],
    ) {
        return SshTestOutcome::AuthRequired;
    }
    if exit.is_none()
        || has_any(
            &low,
            &[
                "could not resolve hostname",
                "connection timed out",
                "operation timed out",
                "connection refused",
                "no route to host",
                "network is unreachable",
            ],
        )
    {
        return SshTestOutcome::Unreachable;
    }
    SshTestOutcome::Failed(last_line(stderr).unwrap_or_else(|| match exit {
        Some(code) => format!("ssh exited with {code}"),
        None => "ssh was stopped".to_owned(),
    }))
}

/// What a prompt from `ssh` asks for, so the dialog can show it right.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum SshPromptKind {
    Password,
    Passphrase,
    /// A yes/no question, such as trusting a new host key; not hidden.
    Confirm,
    /// A keyboard-interactive question the server asked.
    Other,
}

/// The kind of `prompt`, from the words OpenSSH uses.
pub fn prompt_kind(prompt: &str) -> SshPromptKind {
    let low = prompt.to_ascii_lowercase();
    if low.contains("passphrase") {
        SshPromptKind::Passphrase
    } else if low.contains("(yes/no") || low.contains("continue connecting") {
        SshPromptKind::Confirm
    } else if low.contains("password") {
        SshPromptKind::Password
    } else {
        SshPromptKind::Other
    }
}

/// The state of one host's kept connection.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "kind", content = "reason", rename_all = "camelCase")]
pub enum SshConnState {
    #[default]
    Disconnected,
    Connecting,
    Connected,
    /// A stable code (`auth_required`, `host_key_unknown`, `unreachable`,
    /// `exited`, `spawn`) or the last line `ssh` printed.
    Failed(String),
}

/// One host's kept connection as a state machine. Each method returns
/// whether the state changed, so the caller knows when to tell the UI.
#[derive(Debug, Default)]
pub struct Connection {
    state: SshConnState,
    /// When the settle clock started: the start, or the last prompt closed.
    since: Option<Instant>,
    prompts: usize,
    stopping: bool,
    stderr: String,
}

impl Connection {
    pub fn state(&self) -> &SshConnState {
        &self.state
    }

    /// The process runs or is starting.
    pub fn live(&self) -> bool {
        matches!(
            self.state,
            SshConnState::Connecting | SshConnState::Connected
        )
    }

    fn set(&mut self, next: SshConnState) -> bool {
        let changed = self.state != next;
        self.state = next;
        changed
    }

    /// A new run begins. Refused (false) while one is live.
    pub fn start(&mut self, now: Instant) -> bool {
        if self.live() {
            return false;
        }
        self.since = Some(now);
        self.prompts = 0;
        self.stopping = false;
        self.stderr.clear();
        self.set(SshConnState::Connecting)
    }

    /// The process could not be started.
    pub fn spawn_failed(&mut self, message: &str) -> bool {
        self.since = None;
        self.set(SshConnState::Failed(format!("spawn: {message}")))
    }

    /// More stderr. `ssh` saying it authenticated means connected.
    pub fn stderr(&mut self, text: &str) -> bool {
        self.stderr.push_str(text);
        if self.stderr.len() > STDERR_TAIL {
            let mut cut = self.stderr.len() - STDERR_TAIL;
            while !self.stderr.is_char_boundary(cut) {
                cut += 1;
            }
            self.stderr.drain(..cut);
        }
        if self.state == SshConnState::Connecting
            && !self.stopping
            && self.stderr.contains("Authenticated to ")
        {
            return self.set(SshConnState::Connected);
        }
        false
    }

    /// `ssh` asked something; the settle clock waits for the answer.
    pub fn prompt_opened(&mut self) {
        self.prompts += 1;
    }

    /// The prompt was answered or cancelled; the settle clock starts again.
    pub fn prompt_closed(&mut self, now: Instant) {
        self.prompts = self.prompts.saturating_sub(1);
        self.since = Some(now);
    }

    /// Called now and then: a run still up `SETTLE` after its start or its
    /// last prompt, with none open, is connected.
    pub fn tick(&mut self, now: Instant) -> bool {
        let settled = self
            .since
            .is_some_and(|s| now.saturating_duration_since(s) >= SETTLE);
        if self.state == SshConnState::Connecting && !self.stopping && self.prompts == 0 && settled
        {
            return self.set(SshConnState::Connected);
        }
        false
    }

    /// The person asked to disconnect: the exit that follows is no failure.
    pub fn stop(&mut self) -> bool {
        self.stopping = true;
        self.prompts = 0;
        self.set(SshConnState::Disconnected)
    }

    /// The process ended with `exit` (`None` when killed). After a stop it
    /// is disconnected; else it failed, with the classified reason.
    pub fn exited(&mut self, exit: Option<i32>) -> bool {
        self.since = None;
        self.prompts = 0;
        if self.stopping || !self.live() {
            self.stopping = false;
            return self.set(SshConnState::Disconnected);
        }
        let reason = classify(exit, &self.stderr).reason();
        self.set(SshConnState::Failed(reason))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Messages as OpenSSH prints them.
    const DENIED: &str = "deploy@web.example.com: Permission denied (publickey,password).\r\n";
    const HOST_KEY: &str = "No ED25519 host key is known for web.example.com and you have requested strict checking.\nHost key verification failed.\n";
    const CHANGED: &str = "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\nHost key verification failed.\n";
    const RESOLVE: &str = "ssh: Could not resolve hostname nohost: Name or service not known\n";
    const RESOLVE_WIN: &str = "ssh: Could not resolve hostname nohost: No such host is known. \r\n";
    const TIMED_OUT: &str = "ssh: connect to host 10.255.255.1 port 22: Connection timed out\n";
    const REFUSED: &str = "ssh: connect to host localhost port 2222: Connection refused\n";
    const RESET: &str = "kex_exchange_identification: read: Connection reset by peer\nConnection reset by 127.0.0.1 port 22\n";

    #[test]
    fn exit_zero_is_ok() {
        assert_eq!(classify(Some(0), ""), SshTestOutcome::Ok);
        assert_eq!(classify(Some(0), DENIED), SshTestOutcome::Ok);
    }

    #[test]
    fn permission_denied_is_auth_required() {
        assert_eq!(classify(Some(255), DENIED), SshTestOutcome::AuthRequired);
        assert_eq!(
            classify(
                Some(255),
                "Received disconnect from 1.2.3.4 port 22:2: Too many authentication failures\n"
            ),
            SshTestOutcome::AuthRequired
        );
    }

    #[test]
    fn host_key_failures_are_host_key_unknown() {
        assert_eq!(
            classify(Some(255), HOST_KEY),
            SshTestOutcome::HostKeyUnknown
        );
        assert_eq!(classify(Some(255), CHANGED), SshTestOutcome::HostKeyUnknown);
    }

    #[test]
    fn network_failures_are_unreachable() {
        for stderr in [RESOLVE, RESOLVE_WIN, TIMED_OUT, REFUSED] {
            assert_eq!(
                classify(Some(255), stderr),
                SshTestOutcome::Unreachable,
                "{stderr}"
            );
        }
        // Killed after the timeout.
        assert_eq!(classify(None, ""), SshTestOutcome::Unreachable);
    }

    #[test]
    fn anything_else_is_failed_with_the_last_line() {
        assert_eq!(
            classify(Some(255), RESET),
            SshTestOutcome::Failed("Connection reset by 127.0.0.1 port 22".into())
        );
        assert_eq!(
            classify(Some(1), "debug1: x\n\n"),
            SshTestOutcome::Failed("ssh exited with 1".into())
        );
        let long = "x".repeat(500);
        match classify(Some(255), &long) {
            SshTestOutcome::Failed(m) => assert_eq!(m.len(), 200),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn reasons_are_stable_codes() {
        assert_eq!(SshTestOutcome::AuthRequired.reason(), "auth_required");
        assert_eq!(SshTestOutcome::HostKeyUnknown.reason(), "host_key_unknown");
        assert_eq!(SshTestOutcome::Unreachable.reason(), "unreachable");
        assert_eq!(SshTestOutcome::Failed("boom".into()).reason(), "boom");
    }

    #[test]
    fn outcome_serializes_with_a_kind() {
        let json = serde_json::to_string(&SshTestOutcome::Failed("x".into())).unwrap();
        assert_eq!(json, r#"{"kind":"failed","message":"x"}"#);
        let json = serde_json::to_string(&SshTestOutcome::AuthRequired).unwrap();
        assert_eq!(json, r#"{"kind":"authRequired"}"#);
        let json = serde_json::to_string(&SshConnState::Failed("unreachable".into())).unwrap();
        assert_eq!(json, r#"{"kind":"failed","reason":"unreachable"}"#);
    }

    #[test]
    fn prompt_kinds() {
        assert_eq!(
            prompt_kind("deploy@web.example.com's password: "),
            SshPromptKind::Password
        );
        assert_eq!(
            prompt_kind("Enter passphrase for key '/home/me/.ssh/id_ed25519': "),
            SshPromptKind::Passphrase
        );
        assert_eq!(
            prompt_kind("Are you sure you want to continue connecting (yes/no/[fingerprint])? "),
            SshPromptKind::Confirm
        );
        assert_eq!(prompt_kind("Verification code: "), SshPromptKind::Other);
    }

    #[test]
    fn settles_into_connected() {
        let t0 = Instant::now();
        let mut c = Connection::default();
        assert_eq!(c.state(), &SshConnState::Disconnected);
        assert!(c.start(t0));
        assert_eq!(c.state(), &SshConnState::Connecting);
        assert!(!c.start(t0), "a second start is refused while live");
        assert!(!c.tick(t0 + Duration::from_secs(2)));
        assert!(c.tick(t0 + SETTLE));
        assert_eq!(c.state(), &SshConnState::Connected);
        assert!(!c.tick(t0 + SETTLE * 2), "no change twice");
    }

    #[test]
    fn authenticated_line_connects_at_once() {
        let t0 = Instant::now();
        let mut c = Connection::default();
        c.start(t0);
        assert!(!c.stderr("Connection established.\n"));
        assert!(c.stderr("Authenticated to web.example.com ([1.2.3.4]:22) using \"publickey\".\n"));
        assert_eq!(c.state(), &SshConnState::Connected);
    }

    #[test]
    fn an_open_prompt_holds_the_settle_clock() {
        let t0 = Instant::now();
        let mut c = Connection::default();
        c.start(t0);
        c.prompt_opened();
        assert!(!c.tick(t0 + SETTLE * 10));
        assert_eq!(c.state(), &SshConnState::Connecting);
        let answered = t0 + SETTLE * 10;
        c.prompt_closed(answered);
        assert!(!c.tick(answered + Duration::from_secs(2)));
        assert!(c.tick(answered + SETTLE));
    }

    #[test]
    fn exit_while_connecting_fails_with_the_reason() {
        let t0 = Instant::now();
        let mut c = Connection::default();
        c.start(t0);
        c.stderr(DENIED);
        assert!(c.exited(Some(255)));
        assert_eq!(c.state(), &SshConnState::Failed("auth_required".into()));
        // A failed host can start again.
        assert!(c.start(t0));
        c.stderr(REFUSED);
        c.exited(Some(255));
        assert_eq!(c.state(), &SshConnState::Failed("unreachable".into()));
    }

    #[test]
    fn exit_while_connected_fails_too() {
        let t0 = Instant::now();
        let mut c = Connection::default();
        c.start(t0);
        c.tick(t0 + SETTLE);
        c.stderr("Timeout, server web.example.com not responding.\n");
        assert!(c.exited(Some(255)));
        assert_eq!(
            c.state(),
            &SshConnState::Failed("Timeout, server web.example.com not responding.".into())
        );
    }

    #[test]
    fn stop_then_exit_is_disconnected() {
        let t0 = Instant::now();
        let mut c = Connection::default();
        c.start(t0);
        c.tick(t0 + SETTLE);
        assert!(c.stop());
        assert_eq!(c.state(), &SshConnState::Disconnected);
        assert!(!c.exited(None));
        assert_eq!(c.state(), &SshConnState::Disconnected);
        // Stopped while connecting: the settle clock does not connect it.
        c.start(t0);
        c.stop();
        assert!(!c.tick(t0 + SETTLE));
        assert!(!c.stderr("Authenticated to x\n"));
        assert_eq!(c.state(), &SshConnState::Disconnected);
    }

    #[test]
    fn spawn_failure() {
        let mut c = Connection::default();
        c.start(Instant::now());
        assert!(c.spawn_failed("program not found"));
        assert_eq!(
            c.state(),
            &SshConnState::Failed("spawn: program not found".into())
        );
        assert!(!c.live());
    }

    #[test]
    fn stderr_keeps_only_a_tail() {
        let mut c = Connection::default();
        c.start(Instant::now());
        for _ in 0..100 {
            c.stderr(&"é".repeat(100));
        }
        assert!(c.stderr.len() <= STDERR_TAIL + 4);
    }
}
