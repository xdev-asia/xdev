//! What the pipe API of `interprocess` does not cover on Windows: a read that
//! gives up at a deadline. A named pipe has no receive timeout, so a watchdog
//! thread cancels the blocked read once the deadline has passed.

use std::io;
use std::os::windows::io::{AsRawHandle, BorrowedHandle};
use std::ptr;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use windows_sys::Win32::System::IO::CancelIoEx;

/// How often a cancel is sent again while the read has not ended: the read
/// may not have reached the pipe yet when the first one went out.
const RETRY: Duration = Duration::from_millis(20);

#[derive(Debug)]
struct State {
    until: Instant,
    /// The deadline has passed; reads fail until a new one is set.
    fired: bool,
    /// A read is in progress on the pipe.
    reading: bool,
    quit: bool,
}

type Shared = Arc<(Mutex<State>, Condvar)>;

/// Cancels the reads on one pipe handle that run past a deadline. Dropping it
/// stops the thread, so the handle must outlive it.
#[derive(Debug)]
pub(crate) struct Watchdog {
    shared: Shared,
    thread: Option<JoinHandle<()>>,
}

impl Watchdog {
    pub(crate) fn start(handle: BorrowedHandle<'_>, until: Instant) -> io::Result<Watchdog> {
        let shared: Shared = Arc::new((
            Mutex::new(State {
                until,
                fired: false,
                reading: false,
                quit: false,
            }),
            Condvar::new(),
        ));
        // A handle is not `Send`; the owner joins this thread before it closes it.
        let raw = handle.as_raw_handle() as usize;
        let watch = shared.clone();
        let thread = thread::Builder::new()
            .name("xdev-ipc-deadline".into())
            .spawn(move || watch_over(raw, &watch))?;
        Ok(Watchdog {
            shared,
            thread: Some(thread),
        })
    }

    /// A new deadline; a read that failed at the old one may read again.
    pub(crate) fn set(&self, until: Instant) {
        let mut s = lock(&self.shared);
        s.until = until;
        s.fired = false;
        self.shared.1.notify_all();
    }

    /// Runs `read` unless the deadline has passed. A read the watchdog
    /// cancelled fails with `TimedOut`; bytes that arrived first still count.
    pub(crate) fn read(&self, read: impl FnOnce() -> io::Result<usize>) -> io::Result<usize> {
        {
            let mut s = lock(&self.shared);
            if s.fired || Instant::now() >= s.until {
                s.fired = true;
                return Err(timed_out());
            }
            s.reading = true;
        }
        let result = read();
        let mut s = lock(&self.shared);
        s.reading = false;
        match result {
            Err(_) if s.fired => Err(timed_out()),
            other => other,
        }
    }
}

impl Drop for Watchdog {
    fn drop(&mut self) {
        lock(&self.shared).quit = true;
        self.shared.1.notify_all();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn watch_over(raw: usize, shared: &Shared) {
    let (state, wake) = &**shared;
    let mut s = state.lock().unwrap_or_else(PoisonError::into_inner);
    loop {
        if s.quit {
            return;
        }
        let now = Instant::now();
        if !s.fired && now < s.until {
            let wait = s.until - now;
            s = wake
                .wait_timeout(s, wait)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
            continue;
        }
        s.fired = true;
        if s.reading {
            cancel_io(raw);
            s = wake
                .wait_timeout(s, RETRY)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        } else {
            s = wake.wait(s).unwrap_or_else(PoisonError::into_inner);
        }
    }
}

fn lock(shared: &Shared) -> MutexGuard<'_, State> {
    shared.0.lock().unwrap_or_else(PoisonError::into_inner)
}

pub(crate) fn timed_out() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "no data before the read deadline")
}

/// Cancels the I/O in flight on the handle; the cancelled read ends with
/// `ERROR_OPERATION_ABORTED`.
#[allow(unsafe_code)]
fn cancel_io(raw: usize) {
    // SAFETY: `raw` is the pipe handle of the stream that owns the watchdog,
    // and that stream joins this thread before it closes the handle, so the
    // handle is open here. A null OVERLAPPED cancels every request on it; a
    // failure (nothing to cancel) is harmless.
    unsafe {
        CancelIoEx(raw as _, ptr::null());
    }
}
