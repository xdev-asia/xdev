//! xDev ID sign-in: thin glue between the `xdev-id` crate and Tauri.
//!
//! The token never reaches the webview: commands and the change event carry only
//! `XdevIdState`. Logging is fixed text only, never a URL, code, state, verifier, token,
//! email or error text.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use ::xdev_id::{
    CallError, E_CODE, E_EXPIRED, E_KEYCHAIN, E_LINK, E_STATE, E_TIMEOUT, E_UNAVAILABLE, Keychain,
    REFRESH_EVERY, Redeem, Session, TokenStore, Transport, UreqTransport, XdevIdState,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;

use crate::commands::CmdError;

pub const CHANGED_EVENT: &str = "xdev-id://changed";

/// How often the background thread looks for an expired attempt.
const TICK: Duration = Duration::from_secs(30);

/// Every `E_*` code, to turn a notice back into a `&'static str`.
const CODES: [&str; 7] = [
    E_KEYCHAIN,
    E_UNAVAILABLE,
    E_LINK,
    E_STATE,
    E_CODE,
    E_EXPIRED,
    E_TIMEOUT,
];

type Notify<'a> = &'a dyn Fn(&XdevIdState);

fn fail(code: &'static str) -> CmdError {
    CmdError { code, detail: None }
}

pub struct XdevIdHub {
    session: Mutex<Session>,
    store: Arc<dyn TokenStore>,
    http: Arc<dyn Transport>,
    base: String,
}

impl XdevIdHub {
    pub fn new(store: Arc<dyn TokenStore>, http: Arc<dyn Transport>, base: String) -> XdevIdHub {
        XdevIdHub {
            session: Mutex::new(Session::new(base.clone())),
            store,
            http,
            base,
        }
    }

    /// The app's hub: the OS keychain, the network, `XDEV_ID_URL` if it is safe.
    pub fn production() -> XdevIdHub {
        let base = ::xdev_id::base_url(std::env::var("XDEV_ID_URL").ok().as_deref());
        XdevIdHub::new(Arc::new(Keychain), Arc::new(UreqTransport), base)
    }

    /// The lock is never held across HTTP or a keychain prompt-free wait longer than a call.
    fn lock(&self) -> MutexGuard<'_, Session> {
        self.session.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn state(&self) -> XdevIdState {
        self.lock().state()
    }

    /// Reads the keychain into memory (start-up).
    pub fn load(&self, notify: Notify) -> Result<(), &'static str> {
        let result = self.lock().load(&*self.store);
        if result.is_ok() {
            notify(&self.state());
        }
        result
    }

    /// Starts an attempt and returns the link to open.
    pub fn begin(
        &self,
        bytes: ([u8; 32], [u8; 32]),
        device: &str,
        now: Instant,
        notify: Notify,
    ) -> Result<String, CmdError> {
        let begun = self.lock().begin(&*self.store, bytes, device, now);
        let begin = begun.map_err(fail)?;
        notify(&self.state());
        Ok(begin.link)
    }

    pub fn cancel(&self, notify: Notify) -> XdevIdState {
        self.lock().cancel();
        let state = self.state();
        notify(&state);
        state
    }

    /// A pasted link: errors come back to the person.
    pub fn paste(&self, raw: &str, now: Instant, notify: Notify) -> Result<XdevIdState, CmdError> {
        let state = self.accept_and_complete(raw, now, notify).map_err(fail)?;
        // A failed exchange ends in a notice; the paste form shows it as its error.
        if let XdevIdState::SignedOut {
            notice: Some(notice),
        } = &state
            && let Some(code) = CODES.iter().find(|c| **c == notice)
        {
            return Err(fail(code));
        }
        Ok(state)
    }

    /// A deep link: nobody is told about a stray or wrong link. Returns whether it was ours.
    pub fn deep_link(&self, raw: &str, now: Instant, notify: Notify) -> bool {
        self.accept_and_complete(raw, now, notify).is_ok()
    }

    fn accept_and_complete(
        &self,
        raw: &str,
        now: Instant,
        notify: Notify,
    ) -> Result<XdevIdState, &'static str> {
        let accepted = self.lock().accept(raw, now);
        match accepted {
            Err(code) => {
                if code == E_TIMEOUT {
                    notify(&self.state());
                }
                Err(code)
            }
            Ok(None) => {
                let state = self.state();
                notify(&state);
                Ok(state)
            }
            Ok(Some(redeem)) => Ok(self.complete(redeem, notify)),
        }
    }

    /// Exchange, profile, store. No lock is held during HTTP.
    fn complete(&self, redeem: Redeem, notify: Notify) -> XdevIdState {
        let http = &*self.http;
        let outcome = match ::xdev_id::exchange(http, &self.base, &redeem.code, &redeem.verifier) {
            Ok(reply) => match ::xdev_id::me(http, &self.base, &reply.token) {
                Ok(me) => Ok((reply, me)),
                Err(e) => {
                    ::xdev_id::sign_out(http, &self.base, &reply.token);
                    Err(e)
                }
            },
            Err(e) => Err(e),
        };
        let token = outcome.as_ref().ok().map(|(r, _)| r.token.clone());
        let image = outcome.as_ref().ok().and_then(|(_, m)| m.image.clone());
        let finished = self.lock().finish(&*self.store, redeem.generation, outcome);
        let applied = matches!(finished, Ok(true));
        if !applied && let Some(token) = &token {
            // Cancelled, replaced or unstorable: the new session must not linger.
            ::xdev_id::sign_out(http, &self.base, token);
        }
        let state = self.state();
        notify(&state);
        if applied && token.is_some() {
            self.load_avatar(image.as_deref(), notify);
        }
        self.state()
    }

    fn load_avatar(&self, image: Option<&str>, notify: Notify) {
        let Some(image) = image else { return };
        let Some(data) = ::xdev_id::fetch_avatar(&*self.http, image) else {
            return;
        };
        if self.lock().set_avatar(Some(data)) {
            notify(&self.state());
        }
    }

    /// `/me`: renews the session on the service and refreshes the profile.
    pub fn refresh(&self, notify: Notify) -> XdevIdState {
        let Some(token) = self.lock().token() else {
            return self.state();
        };
        let result = ::xdev_id::me(&*self.http, &self.base, &token);
        let image = result.as_ref().ok().and_then(|m| m.image.clone());
        let unauthorized = matches!(result, Err(CallError::Unauthorized));
        let changed = self.lock().refreshed(&*self.store, &token, result);
        if changed {
            notify(&self.state());
        }
        if !unauthorized {
            let needs_avatar = matches!(
                self.state(),
                XdevIdState::SignedIn { user } if user.avatar.is_none()
            );
            if needs_avatar {
                self.load_avatar(image.as_deref(), notify);
            }
        }
        self.state()
    }

    pub fn expire(&self, now: Instant, notify: Notify) -> bool {
        let changed = self.lock().expire(now);
        if changed {
            notify(&self.state());
        }
        changed
    }

    pub fn sign_out(&self, notify: Notify) -> Result<XdevIdState, CmdError> {
        let (token, cleared) = self.lock().sign_out(&*self.store);
        if let Some(token) = &token {
            ::xdev_id::sign_out(&*self.http, &self.base, token);
        }
        let state = self.state();
        notify(&state);
        cleared.map_err(fail)?;
        Ok(state)
    }

    /// The link of the running attempt, to open it again. It starts no new attempt, so a
    /// callback from the first browser tab still matches.
    pub fn reopen_link(&self) -> Result<String, CmdError> {
        match self.state() {
            XdevIdState::SigningIn { link } => Ok(link),
            _ => Err(fail(E_STATE)),
        }
    }

    pub fn manage_url(&self) -> String {
        format!("{}/", self.base)
    }
}

fn emitter(app: &AppHandle) -> impl Fn(&XdevIdState) + use<> {
    let app = app.clone();
    move |state| {
        let _ = app.emit(CHANGED_EVENT, state);
    }
}

fn random_bytes() -> Result<([u8; 32], [u8; 32]), CmdError> {
    // The OS random source failing leaves nothing safe to do.
    ::xdev_id::random_pair().map_err(|_| fail(E_UNAVAILABLE))
}

#[tauri::command(async)]
pub fn xdev_id_state(hub: State<'_, XdevIdHub>) -> XdevIdState {
    hub.state()
}

#[tauri::command(async)]
pub fn xdev_id_sign_in(app: AppHandle, hub: State<'_, XdevIdHub>) -> Result<XdevIdState, CmdError> {
    let link = hub.begin(
        random_bytes()?,
        &::xdev_id::device_name(),
        Instant::now(),
        &emitter(&app),
    )?;
    // The link stays in the state, so a failed open is covered by "Copy link".
    if app.opener().open_url(link, None::<&str>).is_err() {
        eprintln!("xdev id: could not open the browser");
    }
    Ok(hub.state())
}

#[tauri::command(async)]
pub fn xdev_id_paste(
    app: AppHandle,
    hub: State<'_, XdevIdHub>,
    link: String,
) -> Result<XdevIdState, CmdError> {
    hub.paste(&link, Instant::now(), &emitter(&app))
}

#[tauri::command(async)]
pub fn xdev_id_cancel(app: AppHandle, hub: State<'_, XdevIdHub>) -> XdevIdState {
    hub.cancel(&emitter(&app))
}

#[tauri::command(async)]
pub fn xdev_id_sign_out(
    app: AppHandle,
    hub: State<'_, XdevIdHub>,
) -> Result<XdevIdState, CmdError> {
    hub.sign_out(&emitter(&app))
}

#[tauri::command(async)]
pub fn xdev_id_refresh(app: AppHandle, hub: State<'_, XdevIdHub>) -> XdevIdState {
    hub.refresh(&emitter(&app))
}

#[tauri::command(async)]
pub fn xdev_id_reopen(app: AppHandle, hub: State<'_, XdevIdHub>) -> Result<(), CmdError> {
    let link = hub.reopen_link()?;
    app.opener()
        .open_url(link, None::<&str>)
        .map_err(|_| fail(E_UNAVAILABLE))
}

#[tauri::command(async)]
pub fn xdev_id_manage(app: AppHandle, hub: State<'_, XdevIdHub>) -> Result<(), CmdError> {
    app.opener()
        .open_url(hub.manage_url(), None::<&str>)
        .map_err(|_| fail(E_UNAVAILABLE))
}

/// Whether this build registers the scheme at runtime.
/// Release: Linux only (AppImage and deb need the handler; the Windows installer and the
/// macOS Info.plist register it). Debug: Windows and Linux, and only with
/// `XDEV_DEV_DEEP_LINK=1`, so a dev build never takes over an installed xDev's handler.
pub fn runtime_registration(debug: bool, os: &str, dev_flag: Option<&str>) -> bool {
    if debug {
        matches!(os, "windows" | "linux") && dev_flag == Some("1")
    } else {
        os == "linux"
    }
}

/// Release builds run one instance (a second launch focuses the first, and carries a
/// deep link to it). Debug builds only with the flag, so dev and installed run side by side.
pub fn single_instance_on(debug: bool, dev_flag: Option<&str>) -> bool {
    !debug || dev_flag == Some("1")
}

/// Brings the main window forward. Errors are ignored.
pub fn focus_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Setup: the deep link handler, the optional runtime registration, and a thread that
/// loads the keychain, runs the first `/me`, then repeats it every six hours.
pub fn start(app: &AppHandle) {
    let dev_flag = std::env::var("XDEV_DEV_DEEP_LINK").ok();
    if runtime_registration(
        cfg!(debug_assertions),
        std::env::consts::OS,
        dev_flag.as_deref(),
    ) {
        let app = app.clone();
        std::thread::spawn(move || {
            if app.deep_link().register_all().is_err() {
                eprintln!("xdev id: could not register the xdev:// link");
            }
        });
    }

    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            let app = handle.clone();
            // The exchange blocks, so it never runs on the event thread.
            std::thread::spawn(move || {
                let hub = app.state::<XdevIdHub>();
                if hub.deep_link(url.as_str(), Instant::now(), &emitter(&app)) {
                    focus_main(&app);
                }
            });
        }
    });

    let app = app.clone();
    std::thread::spawn(move || {
        let hub = app.state::<XdevIdHub>();
        let notify = emitter(&app);
        if hub.load(&notify).is_err() {
            eprintln!("xdev id: the system keychain is not available");
        }
        hub.refresh(&notify);
        let mut next = Instant::now() + REFRESH_EVERY;
        loop {
            std::thread::sleep(TICK);
            let now = Instant::now();
            hub.expire(now, &notify);
            if now >= next {
                hub.refresh(&notify);
                next = now + REFRESH_EVERY;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use ::xdev_id::{FakeTransport, MemoryStore, Offline, Response, b64url};

    use super::*;

    const TOKEN: &str = "tok_tok_tok_tok_tok_tok_tok";
    const BASE: &str = "https://id.test";

    fn hub(
        replies: Vec<Result<Response, Offline>>,
    ) -> (XdevIdHub, Arc<MemoryStore>, Arc<FakeTransport>) {
        let store = Arc::new(MemoryStore::default());
        let http = Arc::new(FakeTransport::new(replies));
        let hub = XdevIdHub::new(store.clone(), http.clone(), BASE.to_owned());
        (hub, store, http)
    }

    fn ok_replies() -> Vec<Result<Response, Offline>> {
        vec![
            Ok(Response::json(
                200,
                &format!(r#"{{"token":"{TOKEN}","expiresAt":"2027-01-01T00:00:00Z"}}"#),
            )),
            Ok(Response::json(
                200,
                r#"{"user":{"id":"1","name":"Duy","email":"d@x.test","image":null}}"#,
            )),
        ]
    }

    fn link_for(state_bytes: [u8; 32]) -> String {
        format!(
            "xdev://auth/callback?code={}&state={}",
            b64url(&[3; 32]),
            b64url(&state_bytes)
        )
    }

    fn silent(_: &XdevIdState) {}

    #[test]
    fn registration_table() {
        // (debug, os, flag, expected)
        let rows = [
            (false, "linux", None, true),
            (false, "linux", Some("1"), true),
            (false, "windows", None, false),
            (false, "windows", Some("1"), false),
            (false, "macos", None, false),
            (false, "macos", Some("1"), false),
            (true, "linux", None, false),
            (true, "linux", Some("1"), true),
            (true, "linux", Some("0"), false),
            (true, "windows", None, false),
            (true, "windows", Some("1"), true),
            (true, "macos", None, false),
            (true, "macos", Some("1"), false),
        ];
        for (debug, os, flag, want) in rows {
            assert_eq!(
                runtime_registration(debug, os, flag),
                want,
                "{debug} {os} {flag:?}"
            );
        }
    }

    #[test]
    fn single_instance_table() {
        assert!(single_instance_on(false, None));
        assert!(single_instance_on(false, Some("1")));
        assert!(!single_instance_on(true, None));
        assert!(!single_instance_on(true, Some("0")));
        assert!(single_instance_on(true, Some("1")));
    }

    #[test]
    fn a_pasted_link_signs_in() {
        let (hub, store, http) = hub(ok_replies());
        let now = Instant::now();
        let seen = Mutex::new(Vec::new());
        let notify = |s: &XdevIdState| seen.lock().unwrap().push(s.clone());
        let link = hub
            .begin(([1; 32], [2; 32]), "Duy PC", now, &notify)
            .unwrap();
        assert!(link.starts_with("https://id.test/desktop?"));

        let state = hub.paste(&link_for([2; 32]), now, &notify).unwrap();
        assert!(matches!(&state, XdevIdState::SignedIn { user } if user.name == "Duy"));
        assert_eq!(hub.state(), state);
        assert_eq!(store.load().unwrap().unwrap().token.expose(), TOKEN);

        let sent = http.requests();
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0].url, "https://id.test/api/desktop/token");
        assert_eq!(sent[1].url, "https://id.test/api/desktop/me");
        // The verifier sent is the one behind the link's challenge.
        let body = sent[0].json.as_ref().unwrap().expose().to_owned();
        assert!(body.contains(&b64url(&[1; 32])));

        let seen = seen.lock().unwrap();
        assert!(matches!(seen.first(), Some(XdevIdState::SigningIn { .. })));
        assert!(matches!(seen.last(), Some(XdevIdState::SignedIn { .. })));
        // No state that reached the UI holds the token.
        for s in seen.iter() {
            assert!(!serde_json::to_string(s).unwrap().contains(TOKEN));
        }
    }

    #[test]
    fn paste_errors_carry_a_code_and_no_detail() {
        let (hub, _, http) = hub(vec![]);
        let now = Instant::now();
        let bad = hub.paste("not a link", now, &silent).unwrap_err();
        assert_eq!((bad.code, bad.detail), (E_LINK, None));
        // A valid link with no attempt.
        let none = hub.paste(&link_for([2; 32]), now, &silent).unwrap_err();
        assert_eq!((none.code, none.detail), (E_STATE, None));

        hub.begin(([1; 32], [2; 32]), "d", now, &silent).unwrap();
        let wrong = hub.paste(&link_for([9; 32]), now, &silent).unwrap_err();
        assert_eq!((wrong.code, wrong.detail), (E_STATE, None));
        assert!(matches!(hub.state(), XdevIdState::SigningIn { .. }));
        assert!(http.requests().is_empty());
    }

    #[test]
    fn a_rejected_code_is_a_paste_error() {
        let (hub, store, _) = hub(vec![Ok(Response::json(400, r#"{"error":"invalid_code"}"#))]);
        let now = Instant::now();
        hub.begin(([1; 32], [2; 32]), "d", now, &silent).unwrap();
        let err = hub.paste(&link_for([2; 32]), now, &silent).unwrap_err();
        assert_eq!((err.code, err.detail), (E_CODE, None));
        assert!(store.raw().is_none());
    }

    #[test]
    fn a_deep_link_never_reports_a_stray_link() {
        let (hub, _, http) = hub(ok_replies());
        let now = Instant::now();
        assert!(!hub.deep_link(&link_for([2; 32]), now, &silent));
        hub.begin(([1; 32], [2; 32]), "d", now, &silent).unwrap();
        assert!(!hub.deep_link(&link_for([9; 32]), now, &silent));
        assert!(matches!(hub.state(), XdevIdState::SigningIn { .. }));
        assert!(http.requests().is_empty());
        assert!(hub.deep_link(&link_for([2; 32]), now, &silent));
        assert!(matches!(hub.state(), XdevIdState::SignedIn { .. }));
    }

    #[test]
    fn a_cancelled_attempt_signs_a_late_token_out() {
        // Cancel lands between accept and finish: drive the pieces by hand.
        let (hub, store, http) = hub(ok_replies());
        let now = Instant::now();
        hub.begin(([1; 32], [2; 32]), "d", now, &silent).unwrap();
        let redeem = hub.lock().accept(&link_for([2; 32]), now).unwrap().unwrap();
        hub.cancel(&silent);
        let state = hub.complete(redeem, &silent);
        assert_eq!(state, XdevIdState::SignedOut { notice: None });
        assert!(store.raw().is_none());
        let urls: Vec<String> = http.requests().into_iter().map(|r| r.url).collect();
        assert_eq!(
            urls.last().map(String::as_str),
            Some("https://id.test/api/desktop/signout")
        );
    }

    #[test]
    fn refresh_signs_out_only_on_a_401() {
        let (hub, store, _) = hub(ok_replies());
        let now = Instant::now();
        hub.begin(([1; 32], [2; 32]), "d", now, &silent).unwrap();
        hub.paste(&link_for([2; 32]), now, &silent).unwrap();

        // Offline keeps the state.
        let http = Arc::new(FakeTransport::new(vec![Err(Offline)]));
        let again = XdevIdHub::new(store.clone(), http, BASE.to_owned());
        again.load(&silent).unwrap();
        assert!(matches!(
            again.refresh(&silent),
            XdevIdState::SignedIn { .. }
        ));

        let http = Arc::new(FakeTransport::new(vec![Ok(Response::json(
            401,
            r#"{"error":"unauthorized"}"#,
        ))]));
        let again = XdevIdHub::new(store.clone(), http, BASE.to_owned());
        again.load(&silent).unwrap();
        assert_eq!(
            again.refresh(&silent),
            XdevIdState::SignedOut {
                notice: Some(E_EXPIRED.to_owned())
            }
        );
        assert!(store.raw().is_none());
    }

    #[test]
    fn sign_out_calls_the_service_and_clears_the_keychain() {
        let (hub, store, http) = hub(ok_replies());
        let now = Instant::now();
        hub.begin(([1; 32], [2; 32]), "d", now, &silent).unwrap();
        hub.paste(&link_for([2; 32]), now, &silent).unwrap();
        let state = hub.sign_out(&silent).unwrap();
        assert_eq!(state, XdevIdState::SignedOut { notice: None });
        assert!(store.raw().is_none());
        let last = http.requests().pop().unwrap();
        assert_eq!(last.url, "https://id.test/api/desktop/signout");
        assert_eq!(last.bearer.unwrap().expose(), TOKEN);
    }

    #[test]
    fn sign_in_without_a_keychain_fails_before_opening_anything() {
        let (hub, store, _) = hub(vec![]);
        store.set_fail(true);
        let err = hub
            .begin(([1; 32], [2; 32]), "d", Instant::now(), &silent)
            .unwrap_err();
        assert_eq!((err.code, err.detail), (E_KEYCHAIN, None));
        assert_eq!(hub.state(), XdevIdState::SignedOut { notice: None });
    }

    #[test]
    fn reopen_returns_the_running_link_and_starts_nothing() {
        let (hub, _, http) = hub(ok_replies());
        let now = Instant::now();
        let err = hub.reopen_link().unwrap_err();
        assert_eq!((err.code, err.detail), (E_STATE, None));
        let link = hub.begin(([1; 32], [2; 32]), "d", now, &silent).unwrap();
        assert_eq!(hub.reopen_link().unwrap(), link);
        assert_eq!(hub.reopen_link().unwrap(), link);
        // The same attempt is still the one that completes.
        assert!(hub.deep_link(&link_for([2; 32]), now, &silent));
        assert_eq!(http.requests().len(), 2);
        assert_eq!(hub.reopen_link().unwrap_err().code, E_STATE);
    }

    #[test]
    fn the_manage_page_is_the_service_root() {
        let (hub, _, _) = hub(vec![]);
        assert_eq!(hub.manage_url(), "https://id.test/");
    }
}
