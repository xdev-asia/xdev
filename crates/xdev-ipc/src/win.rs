//! What the pipe API of `interprocess` does not cover on Windows: a read that
//! gives up at a deadline, and the user a process runs as. A named pipe has
//! no receive timeout, so a watchdog thread cancels the blocked read once the
//! deadline has passed.

use std::io;
use std::os::windows::io::{AsRawHandle, BorrowedHandle};
use std::ptr;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use interprocess::os::windows::security_descriptor::SecurityDescriptor;
use widestring::U16CString;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, LocalFree};
use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows_sys::Win32::Security::{
    EqualSid, GetTokenInformation, TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows_sys::Win32::System::IO::CancelIoEx;
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};

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

/// A pipe security descriptor that grants this user full access and nobody
/// else any, so another user can neither connect nor add a server instance.
pub(crate) fn only_current_user() -> io::Result<SecurityDescriptor> {
    // D: the DACL; P: protected, nothing inherited; one ACE allowing (A)
    // generic all (GA) to the SID.
    let sddl = format!("D:P(A;;GA;;;{})", current_user_sid()?);
    let sddl =
        U16CString::from_str(sddl).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    SecurityDescriptor::deserialize(&sddl)
}

/// The SID of the user this process runs as, in its string form (`S-1-5-...`).
pub(crate) fn current_user_sid() -> io::Result<String> {
    let user = user_of(current_process())?;
    sid_string(&user)
}

/// Whether process `pid` runs as the same user as this one. An error when it
/// cannot be told, which callers treat as "no".
pub(crate) fn runs_as_current_user(pid: u32) -> io::Result<bool> {
    let theirs = user_of(open_process(pid)?.0)?;
    let mine = user_of(current_process())?;
    Ok(same_sid(&theirs, &mine))
}

/// A handle closed on drop.
struct Owned(HANDLE);

impl Drop for Owned {
    #[allow(unsafe_code)]
    fn drop(&mut self) {
        // SAFETY: `self.0` is a handle this module opened and nothing else
        // closes.
        unsafe {
            CloseHandle(self.0);
        }
    }
}

/// A `TOKEN_USER` and the SID it points into, in a buffer aligned for it.
struct TokenUserBuf(Vec<u64>);

impl TokenUserBuf {
    #[allow(unsafe_code)]
    fn sid(&self) -> *mut core::ffi::c_void {
        // SAFETY: `GetTokenInformation` filled the buffer with a `TOKEN_USER`;
        // a `Vec<u64>` is aligned for it, and the SID it points to lives in
        // the same buffer.
        unsafe { (*self.0.as_ptr().cast::<TOKEN_USER>()).User.Sid }
    }
}

#[allow(unsafe_code)]
fn current_process() -> HANDLE {
    // SAFETY: no arguments; the pseudo handle needs no closing.
    unsafe { GetCurrentProcess() }
}

#[allow(unsafe_code)]
fn open_process(pid: u32) -> io::Result<Owned> {
    // SAFETY: plain call; a null result is checked.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return Err(io::Error::last_os_error());
    }
    Ok(Owned(process))
}

#[allow(unsafe_code)]
fn user_of(process: HANDLE) -> io::Result<TokenUserBuf> {
    let mut token: HANDLE = ptr::null_mut();
    // SAFETY: `process` is open for the call; `token` is a valid out pointer.
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = Owned(token);
    let mut len = 0u32;
    // SAFETY: a size query: no buffer, `len` is a valid out pointer. It fails
    // with ERROR_INSUFFICIENT_BUFFER and sets `len`.
    unsafe { GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut len) };
    if len == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut buf = TokenUserBuf(vec![0u64; (len as usize).div_ceil(8)]);
    // SAFETY: `buf` holds at least `len` bytes, aligned for a `TOKEN_USER`.
    let ok = unsafe {
        GetTokenInformation(token.0, TokenUser, buf.0.as_mut_ptr().cast(), len, &mut len)
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(buf)
}

#[allow(unsafe_code)]
fn same_sid(a: &TokenUserBuf, b: &TokenUserBuf) -> bool {
    // SAFETY: both SIDs are valid for as long as their buffers live.
    unsafe { EqualSid(a.sid(), b.sid()) != 0 }
}

#[allow(unsafe_code)]
fn sid_string(user: &TokenUserBuf) -> io::Result<String> {
    let mut text: *mut u16 = ptr::null_mut();
    // SAFETY: the SID is valid; `text` is a valid out pointer.
    if unsafe { ConvertSidToStringSidW(user.sid(), &mut text) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: on success `text` is a NUL-terminated string the system
    // allocated; it is read up to the NUL, then freed once with `LocalFree`.
    unsafe {
        let mut len = 0;
        while *text.add(len) != 0 {
            len += 1;
        }
        let sid = String::from_utf16_lossy(std::slice::from_raw_parts(text, len));
        LocalFree(text.cast());
        Ok(sid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_process_runs_as_its_own_user() {
        assert!(current_user_sid().unwrap().starts_with("S-1-"));
        assert!(runs_as_current_user(std::process::id()).unwrap());
    }
}
