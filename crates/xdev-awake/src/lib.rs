//! One OS request that keeps the computer from sleeping: a power request on
//! Windows, `caffeinate` on macOS, `systemd-inhibit` on Linux. Display sleep
//! is not blocked, system sleep only.

use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

#[cfg(windows)]
mod win;

/// Why the request is made, as the OS lists it.
pub const REASON: &str = "xDev: an agent is working";

/// The args of `caffeinate` that block idle sleep until process `pid` exits.
pub fn caffeinate_args(pid: u32) -> Vec<String> {
    ["-i".to_owned(), "-w".to_owned(), pid.to_string()].into()
}

/// The args of `systemd-inhibit` that block idle and sleep while a small
/// shell loop runs. The loop ends by itself when process `pid` (the app) or
/// its own parent (the inhibitor) is gone, so a crash cannot leave the lock.
pub fn systemd_inhibit_args(why: &str, pid: u32) -> Vec<String> {
    let script =
        "p=$PPID; while kill -0 \"$1\" 2>/dev/null && kill -0 \"$p\" 2>/dev/null; do sleep 2; done";
    [
        "--what=idle:sleep".to_owned(),
        "--who=xDev".to_owned(),
        format!("--why={why}"),
        "--mode=block".to_owned(),
        "sh".to_owned(),
        "-c".to_owned(),
        script.to_owned(),
        "sh".to_owned(),
        pid.to_string(),
    ]
    .into()
}

/// A helper program that holds the request while it runs.
#[cfg_attr(windows, allow(dead_code))]
struct Helper {
    program: &'static str,
    args: Vec<String>,
    child: Option<Child>,
}

/// How long a fresh helper is watched for an early exit (a missing D-Bus, a refused request).
#[cfg_attr(windows, allow(dead_code))]
const EARLY_EXIT_WINDOW: Duration = Duration::from_millis(300);

#[cfg_attr(windows, allow(dead_code))]
impl Helper {
    /// Makes sure the helper runs. A helper that has exited since is reaped and started again; one that
    /// exits within `EARLY_EXIT_WINDOW` of its start is reaped and reported as an error.
    fn start(&mut self) -> Result<(), String> {
        if let Some(child) = self.child.as_mut() {
            match child.try_wait() {
                Ok(None) => return Ok(()),
                Ok(Some(_)) => self.child = None,
                Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    self.child = None;
                }
            }
        }
        let mut child = Command::new(self.program)
            .args(&self.args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("{}: {e}", self.program))?;
        let started = Instant::now();
        loop {
            match child.try_wait() {
                // try_wait reaped it.
                Ok(Some(status)) => {
                    return Err(format!("{}: exited at once ({status})", self.program));
                }
                Ok(None) => {}
                Err(e) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("{}: {e}", self.program));
                }
            }
            if started.elapsed() >= EARLY_EXIT_WINDOW {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        self.child = Some(child);
        Ok(())
    }
}

#[cfg_attr(any(windows, unix), allow(dead_code))]
enum Kind {
    #[cfg(windows)]
    Windows(win::Request),
    Helper(Helper),
    None,
}

/// A request not to sleep. `hold` and `release` may repeat; dropping releases.
pub struct SleepBlock(Kind);

impl SleepBlock {
    /// The mechanism of this OS; `available()` is false when there is none.
    pub fn new() -> Self {
        #[cfg(windows)]
        {
            Self(Kind::Windows(win::Request::default()))
        }
        #[cfg(target_os = "macos")]
        {
            Self(Kind::Helper(Helper {
                program: "caffeinate",
                args: caffeinate_args(std::process::id()),
                child: None,
            }))
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            Self(Kind::Helper(Helper {
                program: "systemd-inhibit",
                args: systemd_inhibit_args(REASON, std::process::id()),
                child: None,
            }))
        }
        #[cfg(not(any(windows, unix)))]
        {
            Self(Kind::None)
        }
    }

    pub fn available(&self) -> bool {
        !matches!(self.0, Kind::None)
    }

    /// Asks the OS to stay awake; a second call while held does nothing. A helper that is not running
    /// any more counts as not held and is started again.
    pub fn hold(&mut self) -> Result<(), String> {
        match &mut self.0 {
            #[cfg(windows)]
            Kind::Windows(request) => request.hold(REASON),
            Kind::Helper(helper) => helper.start(),
            Kind::None => Err("not available".to_owned()),
        }
    }

    /// Whether a request is in force: a helper that has exited since `hold` is reaped and counts as not
    /// held; a Windows request cannot die on its own.
    pub fn is_held(&mut self) -> bool {
        match &mut self.0 {
            #[cfg(windows)]
            Kind::Windows(_) => true,
            Kind::Helper(helper) => match helper.child.as_mut().map(|c| c.try_wait()) {
                Some(Ok(None)) => true,
                Some(_) => {
                    if let Some(mut child) = helper.child.take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                    false
                }
                None => false,
            },
            Kind::None => false,
        }
    }

    /// Gives the request back; the helper is killed and reaped.
    pub fn release(&mut self) {
        match &mut self.0 {
            #[cfg(windows)]
            Kind::Windows(request) => request.release(),
            Kind::Helper(helper) => {
                if let Some(mut child) = helper.child.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
            Kind::None => {}
        }
    }
}

impl Default for SleepBlock {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for SleepBlock {
    fn drop(&mut self) {
        self.release();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caffeinate_waits_on_the_app() {
        assert_eq!(caffeinate_args(42), ["-i", "-w", "42"]);
    }

    #[test]
    fn systemd_inhibit_blocks_idle_and_sleep_and_watches_the_app() {
        let args = systemd_inhibit_args("why text", 42);
        assert_eq!(args[0], "--what=idle:sleep");
        assert!(args.contains(&"--who=xDev".to_owned()));
        assert!(args.contains(&"--why=why text".to_owned()));
        assert!(args.contains(&"--mode=block".to_owned()));
        // The program after the options takes the pid as its first argument.
        assert_eq!(args[args.len() - 1], "42");
        assert_eq!(args[args.len() - 2], "sh");
        assert!(args.iter().any(|a| a.contains("kill -0")));
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_request_can_be_set_and_cleared() {
        let mut block = SleepBlock::new();
        assert!(block.available());
        block.hold().unwrap();
        block.hold().unwrap();
        block.release();
        block.release();
    }

    #[cfg(unix)]
    fn helper(program: &'static str, args: &[&str]) -> SleepBlock {
        SleepBlock(Kind::Helper(Helper {
            program,
            args: args.iter().map(|a| (*a).to_owned()).collect(),
            child: None,
        }))
    }

    #[cfg(unix)]
    #[test]
    fn a_helper_that_exits_at_once_is_an_error_and_is_reaped() {
        let mut block = helper("false", &[]);
        assert!(block.hold().unwrap_err().contains("exited at once"));
        match &block.0 {
            Kind::Helper(h) => assert!(h.child.is_none()),
            _ => unreachable!(),
        }
        // Asking again tries again instead of believing it is held.
        assert!(block.hold().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_helper_that_died_later_is_started_again() {
        let mut block = helper("sleep", &["30"]);
        block.hold().unwrap();
        if let Kind::Helper(h) = &mut block.0 {
            let child = h.child.as_mut().unwrap();
            child.kill().unwrap();
            // Wait for the exit to show, without reaping through `Child::wait` first.
            let t = Instant::now();
            while child.try_wait().unwrap().is_none() && t.elapsed() < Duration::from_secs(5) {}
            // `try_wait` reaped it; the slot still holds the dead child.
        }
        block.hold().unwrap();
        match &mut block.0 {
            Kind::Helper(h) => assert!(h.child.as_mut().unwrap().try_wait().unwrap().is_none()),
            _ => unreachable!(),
        }
        block.release();
    }

    #[cfg(not(windows))]
    #[test]
    fn a_missing_helper_is_an_error_not_a_panic() {
        let mut block = SleepBlock(Kind::Helper(Helper {
            program: "xdev-no-such-program",
            args: Vec::new(),
            child: None,
        }));
        assert!(block.hold().is_err());
        block.release();
    }
}
