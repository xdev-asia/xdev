//! A Windows power request: the system stays awake while it is set.

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Power::{
    PowerClearRequest, PowerCreateRequest, PowerRequestSystemRequired, PowerSetRequest,
};
use windows_sys::Win32::System::Threading::{
    POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0,
};

/// The version `PowerCreateRequest` expects (`POWER_REQUEST_CONTEXT_VERSION`).
const CONTEXT_VERSION: u32 = 0;

#[derive(Default)]
pub struct Request {
    handle: Option<HandleBox>,
}

/// A request handle is a plain kernel handle; any thread may use it.
struct HandleBox(HANDLE);

// SAFETY: a kernel handle is not tied to the thread that created it.
#[allow(unsafe_code)]
unsafe impl Send for HandleBox {}

impl Request {
    #[allow(unsafe_code)]
    pub fn hold(&mut self, reason: &str) -> Result<(), String> {
        if self.handle.is_some() {
            return Ok(());
        }
        let mut text: Vec<u16> = reason.encode_utf16().chain(std::iter::once(0)).collect();
        let context = REASON_CONTEXT {
            Version: CONTEXT_VERSION,
            Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
            Reason: REASON_CONTEXT_0 {
                SimpleReasonString: text.as_mut_ptr(),
            },
        };
        // SAFETY: `context` and the wide string it points at outlive the call;
        // the string is nul terminated.
        let handle = unsafe { PowerCreateRequest(&context) };
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error().to_string());
        }
        // SAFETY: `handle` is the open request handle made above.
        if unsafe { PowerSetRequest(handle, PowerRequestSystemRequired) } == 0 {
            let error = std::io::Error::last_os_error().to_string();
            // SAFETY: `handle` is open and not used again.
            unsafe { CloseHandle(handle) };
            return Err(error);
        }
        self.handle = Some(HandleBox(handle));
        Ok(())
    }

    #[allow(unsafe_code)]
    pub fn release(&mut self) {
        if let Some(HandleBox(handle)) = self.handle.take() {
            // SAFETY: `handle` is the open request handle from `hold`, taken
            // out of `self` so it is cleared and closed once.
            unsafe {
                PowerClearRequest(handle, PowerRequestSystemRequired);
                CloseHandle(handle);
            }
        }
    }
}
