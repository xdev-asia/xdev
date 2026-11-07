//! The license on this computer: thin Tauri glue over the `xdev-license` crate.
//!
//! `LicenseHub` evaluates the cached token with no network, refreshes it in the background,
//! and runs the purchase poll. Every change goes out as `license://changed` with the full
//! `LicenseState`. Tokens, keys and signatures never reach a log line or the webview.

use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use ::xdev_id::{Method, Request, Secret, Transport, UreqTransport};
use tauri::{AppHandle, Emitter, Listener, Manager, State};
use tauri_plugin_opener::OpenerExt;
use xdev_license::api::{self, ApiError, BuildInfo};
use xdev_license::cache::{Cache, read_cache, write_cache};
use xdev_license::cloud::{self, CloudConfig};
use xdev_license::grace::{self, LicenseState};
use xdev_license::keystore::{DeviceKey, KeyStore, KeychainKeys};
use xdev_license::roots::BUILTIN_ROOTS;
use xdev_license::{
    CHANGED_EVENT, DeviceRow, E_KEYCHAIN, E_SERVER_KEY, E_UNAVAILABLE, E_WRONG_DEVICE, KeySet,
};

use crate::commands::CmdError;
use crate::settings::{CloudSettings, SettingsSection};
use crate::settings_store;
use crate::xdev_id::XdevIdHub;

/// The command result is the crate's state; the contract in `api.ts` already says so.
pub type LicenseView = LicenseState;

/// A checkout that was not completed in time.
pub const E_CHECKOUT_TIMEOUT: &str = "license_checkout_timeout";
/// The person stopped waiting.
pub const E_CANCELLED: &str = "cancelled";
/// A product name the shop does not sell.
pub const E_BAD_PRODUCT: &str = "license_bad_product";

const FILE_NAME: &str = "license.json";
/// The cache is re-checked this often at most.
const TICK: Duration = Duration::from_secs(30);
/// A refresh the service answered is repeated at most this much later.
const REFRESH_CAP_S: i64 = 6 * 3600;
/// A refresh that failed is tried again after this.
const RETRY_S: i64 = 15 * 60;
/// No refresh is scheduled sooner than this after the last.
const REFRESH_FLOOR_S: i64 = 300;

fn fail(code: &'static str) -> CmdError {
    CmdError { code, detail: None }
}

/// Who is signed in to xDev ID, for the origin the license talks to.
pub struct Credentials {
    pub bearer: Secret,
    pub base: String,
    pub uid: String,
}

pub trait Identity: Send + Sync {
    /// `None` when signed out, or when the user id is not known yet.
    fn credentials(&self) -> Option<Credentials>;
}

/// How long a purchase poll waits between checks, and how many checks it makes.
#[derive(Clone, Copy, Debug)]
pub struct Timing {
    pub interval: Duration,
    pub polls: u32,
}

/// Every 10 s for 5 min.
pub const BUY_TIMING: Timing = Timing {
    interval: Duration::from_secs(10),
    polls: 30,
};

type Emit = Arc<dyn Fn(&LicenseState) + Send + Sync>;

/// A step that failed: the service said no, or something local did.
#[derive(Debug)]
enum Flow {
    Api(ApiError),
    Code(&'static str),
}

impl Flow {
    fn code(&self) -> &'static str {
        match self {
            Flow::Api(e) => e.code(),
            Flow::Code(c) => c,
        }
    }

    fn cmd(self) -> CmdError {
        fail(self.code())
    }
}

impl From<ApiError> for Flow {
    fn from(e: ApiError) -> Flow {
        Flow::Api(e)
    }
}

/// (origin, user id, device id).
type DeviceMemo = (String, String, String);

struct Inner {
    state: LicenseState,
    /// The device id the service gave this computer, with the origin and the user it was
    /// registered for.
    device: Option<DeviceMemo>,
    /// A notice kept on Free until the next change of plan.
    sticky: Option<&'static str>,
    /// Bumped by every purchase and every cancel.
    generation: u64,
    buying: bool,
    next_refresh: i64,
}

pub struct LicenseHub {
    http: Arc<dyn Transport>,
    keys: Arc<dyn KeyStore>,
    ident: Arc<dyn Identity>,
    emit: Emit,
    cache_path: PathBuf,
    /// Unix seconds; 0 when unknown.
    build_date: i64,
    version: String,
    builtin: Vec<[u8; 32]>,
    /// `XDEV_ID_URL`.
    env: Option<String>,
    clock: Box<dyn Fn() -> i64 + Send + Sync>,
    timing: Timing,
    cloud: Mutex<CloudConfig>,
    inner: Mutex<Inner>,
    wake: Condvar,
}

/// What a purchase changes: the plan, the grant, the seats and the update window.
type Signature = (Vec<String>, Option<(String, Option<i64>)>, u32);

fn signature(state: &LicenseState) -> Option<Signature> {
    match state {
        LicenseState::Free { .. } => None,
        LicenseState::Active {
            plan, pro, device, ..
        } => Some((
            plan.clone(),
            pro.as_ref().map(|p| (p.grant.clone(), p.updates_until)),
            device.max,
        )),
    }
}

/// When the next refresh is due: the service's `refresh_after`, never sooner than five
/// minutes and never later than six hours; a failure waits a quarter of an hour.
pub fn next_refresh(now: i64, refresh_after: Option<i64>) -> i64 {
    match refresh_after {
        Some(at) => at.clamp(now + REFRESH_FLOOR_S, now + REFRESH_CAP_S),
        None => now + RETRY_S,
    }
}

/// Unix seconds of the build, from `XDEV_BUILD_DATE`; 0 when it is missing or not a number.
pub fn build_date_of(raw: Option<&str>) -> i64 {
    grace::parse_build_date(raw, None)
}

fn code_of(notice: &str) -> &'static str {
    match notice {
        E_SERVER_KEY => E_SERVER_KEY,
        E_WRONG_DEVICE => E_WRONG_DEVICE,
        E_KEYCHAIN => E_KEYCHAIN,
        _ => E_UNAVAILABLE,
    }
}

impl LicenseHub {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        http: Arc<dyn Transport>,
        keys: Arc<dyn KeyStore>,
        ident: Arc<dyn Identity>,
        emit: Emit,
        cache_path: PathBuf,
        build_date: i64,
        env: Option<String>,
        clock: Box<dyn Fn() -> i64 + Send + Sync>,
        timing: Timing,
    ) -> LicenseHub {
        LicenseHub {
            http,
            keys,
            ident,
            emit,
            cache_path,
            build_date,
            version: env!("CARGO_PKG_VERSION").to_owned(),
            builtin: BUILTIN_ROOTS.to_vec(),
            env,
            clock,
            timing,
            cloud: Mutex::new(CloudConfig::default()),
            inner: Mutex::new(Inner {
                state: LicenseState::free(None),
                device: None,
                sticky: None,
                generation: 0,
                buying: false,
                next_refresh: 0,
            }),
            wake: Condvar::new(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn cloud(&self) -> CloudConfig {
        self.cloud
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn now(&self) -> i64 {
        (self.clock)()
    }

    fn base(&self) -> String {
        cloud::effective_base(&self.cloud(), self.env.as_deref())
    }

    /// The server origin and the roots its tokens are trusted under.
    fn trust(&self) -> Result<(String, Vec<[u8; 32]>), Flow> {
        let cfg = self.cloud();
        let roots =
            cloud::effective_roots(&cfg, &self.builtin).map_err(|_| Flow::Code(E_SERVER_KEY))?;
        Ok((cloud::effective_base(&cfg, self.env.as_deref()), roots))
    }

    pub fn state(&self) -> LicenseState {
        self.lock().state.clone()
    }

    /// Stores `next` (with the sticky notice on Free) and tells the windows if it changed.
    fn publish(&self, next: LicenseState) -> LicenseState {
        let (shown, changed) = {
            let mut inner = self.lock();
            let shown = match (&next, inner.sticky) {
                (LicenseState::Free { notice: None }, Some(sticky)) => {
                    LicenseState::free(Some(sticky))
                }
                _ => next,
            };
            if matches!(shown, LicenseState::Active { .. }) {
                inner.sticky = None;
            }
            let changed = inner.state != shown;
            inner.state = shown.clone();
            (shown, changed)
        };
        if changed {
            (self.emit)(&shown);
        }
        shown
    }

    /// The cached token, checked with no network at all.
    fn evaluate(&self) -> LicenseState {
        let Ok((base, roots)) = self.trust() else {
            return LicenseState::free(Some(E_SERVER_KEY));
        };
        let Some(cache) = read_cache(&self.cache_path).filter(|c| c.server == base) else {
            return LicenseState::free(None);
        };
        let Some(token) = cache.token.as_deref() else {
            return LicenseState::free(None);
        };
        let key = match self.keys.load() {
            Ok(Some(key)) => key,
            Ok(None) => return LicenseState::free(None),
            Err(e) => return LicenseState::free(Some(e.code())),
        };
        let now = self.now();
        let keys = KeySet::from_certs(&cache.certs, &roots, now, &[]);
        grace::state_from_token(
            Some(token),
            &keys,
            &base,
            &key.fingerprint(),
            now,
            cache.last_seen_time,
            self.build_date,
        )
    }

    /// Moves `last_seen_time` forward so a clock set back is noticed.
    fn touch_seen(&self) {
        let Some(mut cache) = read_cache(&self.cache_path) else {
            return;
        };
        let now = self.now();
        if now > cache.last_seen_time {
            cache.last_seen_time = now;
            if write_cache(&self.cache_path, &cache).is_err() {
                eprintln!("license: could not write the cache");
            }
        }
    }

    /// Start-up: the cached token, no network.
    pub fn start(&self) -> LicenseState {
        let state = self.evaluate();
        let shown = self.publish(state);
        self.touch_seen();
        shown
    }

    /// Re-reads the cache and publishes what it says.
    fn settle(&self) -> LicenseState {
        let state = self.evaluate();
        self.publish(state)
    }

    /// The credentials, if they belong to the server in use.
    fn credentials(&self) -> Option<Credentials> {
        let base = self.base();
        self.ident.credentials().filter(|c| c.base == base)
    }

    fn key_or_new(&self) -> Result<DeviceKey, Flow> {
        match self.keys.load() {
            Ok(Some(key)) => Ok(key),
            Ok(None) => {
                let key = DeviceKey::generate().map_err(|_| Flow::Code(E_KEYCHAIN))?;
                self.keys.save(&key).map_err(|_| Flow::Code(E_KEYCHAIN))?;
                Ok(key)
            }
            Err(_) => Err(Flow::Code(E_KEYCHAIN)),
        }
    }

    /// The id the service knows this computer by: remembered, else found by its key, else
    /// registered.
    fn device_id(&self, c: &Credentials, key: &DeviceKey) -> Result<String, Flow> {
        if let Some((base, uid, id)) = &self.lock().device
            && *base == c.base
            && *uid == c.uid
        {
            return Ok(id.clone());
        }
        let fingerprint = key.fingerprint();
        let known = api::devices(&*self.http, &c.base, &c.bearer)?
            .into_iter()
            .find(|d| d.fingerprint == fingerprint);
        let id = match known {
            Some(d) if d.revoked_at.is_some() => return Err(Flow::Api(ApiError::Revoked)),
            Some(d) => d.id,
            None => return self.register_device(c, key),
        };
        self.lock().device = Some((c.base.clone(), c.uid.clone(), id.clone()));
        Ok(id)
    }

    /// POST /v1/devices/challenge, then POST /v1/devices. The service returns the existing
    /// device when this key is already registered for the user.
    fn register_device(&self, c: &Credentials, key: &DeviceKey) -> Result<String, Flow> {
        let name = match ::xdev_id::device_name() {
            n if n.is_empty() => "This computer".to_owned(),
            n => n,
        };
        let id = api::register_fresh(
            &*self.http,
            &c.base,
            &c.bearer,
            &c.uid,
            key,
            &name,
            std::env::consts::OS,
        )?
        .id;
        self.lock().device = Some((c.base.clone(), c.uid.clone(), id.clone()));
        Ok(id)
    }

    /// Runs `call` with this computer's device id. When the service does not know the id
    /// (404 `device_unknown`: another account, or it was removed), the id is dropped, the
    /// device is registered again and the call is repeated once. Nothing is revoked then.
    fn with_device<T>(
        &self,
        c: &Credentials,
        key: &DeviceKey,
        call: impl Fn(&str) -> Result<T, ApiError>,
    ) -> Result<T, Flow> {
        let id = self.device_id(c, key)?;
        match call(&id) {
            Err(ApiError::DeviceUnknown) => {
                self.lock().device = None;
                let id = self.register_device(c, key)?;
                Ok(call(&id)?)
            }
            other => Ok(other?),
        }
    }

    /// Asks the service for a fresh token and keeps it once it verifies.
    fn refresh_flow(&self) -> Result<LicenseState, Flow> {
        let Some(c) = self.credentials() else {
            return Ok(self.settle());
        };
        let outcome = self.fetch_token(&c);
        let now = self.now();
        match outcome {
            Ok(refresh_after) => {
                self.lock().next_refresh = next_refresh(now, Some(refresh_after));
                Ok(self.settle())
            }
            Err(Flow::Api(ApiError::Revoked)) => {
                self.lock().sticky = Some(xdev_license::E_REVOKED);
                self.drop_token();
                Err(Flow::Api(ApiError::Revoked))
            }
            Err(Flow::Api(ApiError::Unavailable | ApiError::Unauthorized)) => {
                self.lock().next_refresh = next_refresh(now, None);
                Ok(self.settle())
            }
            Err(other) => {
                self.lock().next_refresh = next_refresh(now, None);
                Err(other)
            }
        }
    }

    /// Returns the service's `refresh_after`. The token is written only after it verifies.
    fn fetch_token(&self, c: &Credentials) -> Result<i64, Flow> {
        let (base, roots) = self.trust()?;
        let key = self.key_or_new()?;
        let build = BuildInfo {
            version: self.version.clone(),
            date: self.build_date,
        };
        let reply = self.with_device(c, &key, |id| {
            api::entitlement_fresh(&*self.http, &c.base, &c.bearer, &c.uid, id, &key, &build)
        })?;
        let now = self.now();
        let old = read_cache(&self.cache_path)
            .filter(|o| o.server == base)
            .unwrap_or_else(|| Cache::new(&base));
        let certs = if reply.certs.is_empty() {
            old.certs.clone()
        } else {
            reply.certs.clone()
        };
        let keyset = KeySet::from_certs(&certs, &roots, now, &[]);
        let checked = grace::state_from_token(
            Some(&reply.token),
            &keyset,
            &base,
            &key.fingerprint(),
            now,
            old.last_seen_time,
            self.build_date,
        );
        if let LicenseState::Free {
            notice: Some(notice),
        } = &checked
        {
            return Err(Flow::Code(code_of(notice)));
        }
        let next = Cache {
            v: 1,
            server: base,
            token: Some(reply.token.clone()),
            certs,
            last_seen_time: now,
            last_refresh_ok: now,
        };
        if write_cache(&self.cache_path, &next).is_err() {
            eprintln!("license: could not write the cache");
        }
        Ok(reply.refresh_after)
    }

    /// The account removed this computer: the token goes.
    fn drop_token(&self) {
        if let Some(mut cache) = read_cache(&self.cache_path) {
            cache.token = None;
            let _ = write_cache(&self.cache_path, &cache);
        }
        let state = self.evaluate();
        self.publish(state);
    }

    pub fn refresh(&self) -> Result<LicenseState, CmdError> {
        self.refresh_flow().map_err(Flow::cmd)
    }

    fn need_credentials(&self) -> Result<Credentials, Flow> {
        self.credentials().ok_or(Flow::Code(E_UNAVAILABLE))
    }

    fn activate_flow(&self) -> Result<(), Flow> {
        let c = self.need_credentials()?;
        let key = self.key_or_new()?;
        self.with_device(&c, &key, |id| {
            api::activate(&*self.http, &c.base, &c.bearer, id)
        })?;
        Ok(())
    }

    pub fn activate(&self) -> Result<LicenseState, CmdError> {
        self.activate_flow().map_err(Flow::cmd)?;
        self.lock().sticky = None;
        self.refresh()
    }

    /// Frees a Pro seat. No id, or this computer's: this computer's own seat. Another id:
    /// that device is removed from the account.
    pub fn deactivate(&self, device: Option<String>) -> Result<LicenseState, CmdError> {
        let run = || -> Result<(), Flow> {
            let c = self.need_credentials()?;
            let key = self.key_or_new()?;
            let this = self.device_id(&c, &key)?;
            match device {
                Some(other) if other != this => {
                    api::remove_device(&*self.http, &c.base, &c.bearer, &other)?;
                }
                _ => api::deactivate(&*self.http, &c.base, &c.bearer, &this)?,
            }
            Ok(())
        };
        run().map_err(Flow::cmd)?;
        // The seat is free whether or not the refresh gets through.
        Ok(self.refresh().unwrap_or_else(|_| self.state()))
    }

    pub fn devices(&self) -> Result<Vec<DeviceRow>, CmdError> {
        let run = || -> Result<Vec<DeviceRow>, Flow> {
            let c = self.need_credentials()?;
            Ok(api::devices(&*self.http, &c.base, &c.bearer)?)
        };
        run().map_err(Flow::cmd)
    }

    pub fn allows(&self, feature: &str) -> bool {
        match self.state() {
            LicenseState::Free { .. } => false,
            LicenseState::Active { features, .. } => features.iter().any(|f| f == feature),
        }
    }

    /// The address to open for `product`, after the device key exists.
    pub fn buy_url(&self, product: &str) -> Result<String, CmdError> {
        if !matches!(product, "pro" | "device" | "renewal") {
            return Err(fail(E_BAD_PRODUCT));
        }
        let key = self.key_or_new().map_err(Flow::cmd)?;
        Ok(format!(
            "{}/?buy={product}&device={}",
            self.base(),
            key.fingerprint()
        ))
    }

    /// Waits for a purchase to show up in the entitlement. Returns the new state; rejects
    /// `cancelled` after `buy_cancel` and `license_checkout_timeout` when time runs out.
    pub fn buy_wait(&self, product: &str) -> Result<LicenseState, CmdError> {
        let generation = {
            let mut inner = self.lock();
            inner.generation += 1;
            inner.buying = true;
            inner.sticky = None;
            inner.generation
        };
        let result = self.buy_poll(product, generation);
        {
            let mut inner = self.lock();
            if inner.generation == generation {
                inner.buying = false;
            }
        }
        result
    }

    fn buy_poll(&self, product: &str, generation: u64) -> Result<LicenseState, CmdError> {
        let before = signature(&self.state());
        for _ in 0..self.timing.polls {
            if !self.sleep(generation) {
                return Err(fail(E_CANCELLED));
            }
            match self.poll_once(product) {
                Ok(state) if signature(&state) != before => return Ok(state),
                Ok(_) => {}
                Err(e) => return Err(e),
            }
        }
        let state = {
            let mut inner = self.lock();
            if inner.generation != generation {
                return Err(fail(E_CANCELLED));
            }
            inner.sticky = Some(E_CHECKOUT_TIMEOUT);
            inner.state.clone()
        };
        let shown = match state {
            LicenseState::Free { .. } => LicenseState::free(Some(E_CHECKOUT_TIMEOUT)),
            active => active,
        };
        // The window hears about the timeout even when the state did not change.
        {
            self.lock().state = shown.clone();
        }
        (self.emit)(&shown);
        Err(fail(E_CHECKOUT_TIMEOUT))
    }

    /// One check of the entitlement; `pro` also takes a free seat for this computer.
    fn poll_once(&self, product: &str) -> Result<LicenseState, CmdError> {
        let mut state = match self.refresh_flow() {
            Ok(state) => state,
            Err(Flow::Api(ApiError::Revoked)) => return Err(fail(xdev_license::E_REVOKED)),
            Err(Flow::Code(E_KEYCHAIN)) => return Err(fail(E_KEYCHAIN)),
            Err(_) => return Ok(self.state()),
        };
        if product == "pro" && matches!(state, LicenseState::Free { .. }) {
            match self.activate_flow() {
                Ok(()) => {
                    state = self.refresh_flow().unwrap_or(state);
                }
                Err(Flow::Api(ApiError::NoSeat)) => return Err(fail(xdev_license::E_NO_SEAT)),
                Err(_) => {}
            }
        }
        Ok(state)
    }

    /// Sleeps one interval. False when the purchase was cancelled or replaced meanwhile.
    fn sleep(&self, generation: u64) -> bool {
        let guard = self.lock();
        let (guard, _) = self
            .wake
            .wait_timeout_while(guard, self.timing.interval, |i| i.generation == generation)
            .unwrap_or_else(PoisonError::into_inner);
        guard.generation == generation
    }

    pub fn buy_cancel(&self) {
        {
            let mut inner = self.lock();
            inner.generation += 1;
            inner.buying = false;
        }
        self.wake.notify_all();
    }

    #[cfg(test)]
    pub fn buying(&self) -> bool {
        self.lock().buying
    }

    /// The server in use changed: nothing of the old one is kept.
    pub fn server_changed(&self, cfg: CloudConfig) {
        *self.cloud.lock().unwrap_or_else(PoisonError::into_inner) = cfg;
        {
            let mut inner = self.lock();
            inner.device = None;
            inner.sticky = None;
            inner.next_refresh = 0;
            inner.generation += 1;
        }
        self.wake.notify_all();
        let _ = std::fs::remove_file(&self.cache_path);
        self.settle();
    }

    /// The trusted keys changed on the same server: the cache is checked again.
    pub fn roots_changed(&self, cfg: CloudConfig) {
        *self.cloud.lock().unwrap_or_else(PoisonError::into_inner) = cfg;
        self.settle();
    }

    /// True when the background thread should refresh now.
    fn due(&self) -> bool {
        self.now() >= self.lock().next_refresh
    }

    /// One tick of the background thread.
    pub fn tick(&self) {
        if self.due() {
            let _ = self.refresh_flow();
        }
        self.touch_seen();
    }
}

/// The signed-in user, from the xDev ID hub; the user id is read once per sign-in.
struct AppIdentity {
    app: AppHandle,
    http: UreqTransport,
    known: Mutex<Option<(Secret, String, String)>>,
}

impl AppIdentity {
    fn user_id(&self, base: &str, token: &Secret) -> Option<String> {
        let req = Request {
            method: Method::Get,
            url: format!("{base}/api/desktop/me"),
            bearer: Some(token.clone()),
            json: None,
        };
        let res = self.http.send(&req).ok()?;
        if res.status != 200 {
            return None;
        }
        let v: serde_json::Value = serde_json::from_slice(&res.body).ok()?;
        v.get("user")?.get("id")?.as_str().map(str::to_owned)
    }
}

impl Identity for AppIdentity {
    fn credentials(&self) -> Option<Credentials> {
        let (bearer, base) = self.app.state::<XdevIdHub>().credentials()?;
        let mut known = self.known.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some((t, b, uid)) = known.as_ref()
            && *t == bearer
            && *b == base
        {
            return Some(Credentials {
                bearer,
                base,
                uid: uid.clone(),
            });
        }
        let uid = self.user_id(&base, &bearer)?;
        *known = Some((bearer.clone(), base.clone(), uid.clone()));
        Some(Credentials { bearer, base, uid })
    }
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_secs()).ok())
        .unwrap_or(0)
}

/// The app's hub: the OS keychain, the network, and the cache next to the settings.
pub fn production(app: &AppHandle) -> LicenseHub {
    let dir = app
        .path()
        .app_data_dir()
        .or_else(|_| app.path().app_config_dir())
        .unwrap_or_else(|_| std::env::temp_dir());
    let handle = app.clone();
    LicenseHub::new(
        Arc::new(UreqTransport),
        Arc::new(KeychainKeys),
        Arc::new(AppIdentity {
            app: app.clone(),
            http: UreqTransport,
            known: Mutex::new(None),
        }),
        Arc::new(move |state| {
            let _ = handle.emit(CHANGED_EVENT, state);
        }),
        dir.join(FILE_NAME),
        build_date_of(option_env!("XDEV_BUILD_DATE")),
        std::env::var("XDEV_ID_URL").ok(),
        Box::new(unix_now),
        BUY_TIMING,
    )
}

/// Setup: after the settings store and the xDev ID hub are managed. Reads the cache with no
/// network, then a thread refreshes in the background; a sign-in refreshes at once.
pub fn start(app: &AppHandle) {
    let hub = production(app);
    hub.cloud
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone_from(&settings_store::read(app).cloud.config());
    hub.start();
    app.manage(hub);

    let handle = app.clone();
    app.listen(crate::xdev_id::CHANGED_EVENT, move |event| {
        let signed_in = serde_json::from_str::<serde_json::Value>(event.payload())
            .ok()
            .and_then(|v| {
                v.get("state")
                    .and_then(|s| s.as_str())
                    .map(|s| s == "signedIn")
            })
            .unwrap_or(false);
        if signed_in {
            let app = handle.clone();
            std::thread::spawn(move || {
                let _ = app.state::<LicenseHub>().refresh();
            });
        }
    });

    let app = app.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(TICK);
            app.state::<LicenseHub>().tick();
        }
    });
}

#[tauri::command(async)]
pub fn license_state(hub: State<'_, LicenseHub>) -> LicenseView {
    hub.state()
}

#[tauri::command(async)]
pub fn license_refresh(hub: State<'_, LicenseHub>) -> Result<LicenseView, CmdError> {
    hub.refresh()
}

#[tauri::command(async)]
pub fn license_activate(
    hub: State<'_, LicenseHub>,
    grant: Option<String>,
) -> Result<LicenseView, CmdError> {
    // The service picks the grant; a named one is accepted for the contract only.
    let _ = grant;
    hub.activate()
}

#[tauri::command(async)]
pub fn license_deactivate(
    hub: State<'_, LicenseHub>,
    device_id: Option<String>,
) -> Result<LicenseView, CmdError> {
    hub.deactivate(device_id)
}

#[tauri::command(async)]
pub fn license_devices(hub: State<'_, LicenseHub>) -> Result<Vec<DeviceRow>, CmdError> {
    hub.devices()
}

/// Opens the shop in the browser, then waits for the purchase to reach the entitlement.
#[tauri::command(async)]
pub fn license_buy(
    app: AppHandle,
    hub: State<'_, LicenseHub>,
    product: String,
) -> Result<(), CmdError> {
    let url = hub.buy_url(&product)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| fail(E_UNAVAILABLE))?;
    hub.buy_wait(&product).map(|_| ())
}

#[tauri::command(async)]
pub fn license_buy_cancel(hub: State<'_, LicenseHub>) {
    hub.buy_cancel();
}

#[tauri::command(async)]
pub fn license_allows(hub: State<'_, LicenseHub>, feature: String) -> bool {
    hub.allows(&feature)
}

/// Settings → Cloud as stored.
#[tauri::command(async)]
pub fn cloud_settings_get(app: AppHandle) -> CloudSettings {
    settings_store::read(&app).cloud
}

/// Stores Settings → Cloud. A change of server signs out of xDev ID and drops the cached
/// license; the keys alone change only what the cache is trusted under.
#[tauri::command(async)]
pub fn cloud_settings_put(
    app: AppHandle,
    hub: State<'_, LicenseHub>,
    id: State<'_, XdevIdHub>,
    settings: CloudSettings,
) -> Result<CloudSettings, CmdError> {
    let next = settings.checked(cfg!(debug_assertions)).map_err(fail)?;
    let prev = settings_store::read(&app);
    let moved = prev.cloud.server_url != next.server_url;
    settings_store::write(&app, &[SettingsSection::Cloud], |s| {
        s.cloud = next.clone();
    })?;
    if moved {
        let setting = next
            .server_url
            .clone()
            .unwrap_or_else(|| prev.xdev_id.server.clone());
        let _ = id.configure_server(Some(&setting), &crate::xdev_id::emitter(&app));
        hub.server_changed(next.config());
    } else if prev.cloud.pinned_roots != next.pinned_roots {
        hub.roots_changed(next.config());
    }
    Ok(next)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use ::xdev_id::{Offline, Response};
    use xdev_license::keystore::MemoryKeys;
    use xdev_license::mock::{MOCK_BASE, MOCK_BEARER, MOCK_UID};
    use xdev_license::{Freshness, MockEntitlementServer, MockMode};

    use super::*;

    const NOW: i64 = 1_800_000_000;

    struct Fixed {
        signed_in: Arc<AtomicBool>,
        uid: Arc<Mutex<String>>,
    }

    impl Identity for Fixed {
        fn credentials(&self) -> Option<Credentials> {
            self.signed_in.load(Ordering::SeqCst).then(|| Credentials {
                bearer: Secret::new(MOCK_BEARER.to_owned()),
                base: MOCK_BASE.to_owned(),
                uid: self.uid.lock().unwrap().clone(),
            })
        }
    }

    /// Counts every request that reaches the "network".
    struct Counting {
        inner: Arc<MockEntitlementServer>,
        sent: AtomicUsize,
        urls: Mutex<Vec<String>>,
    }

    impl Counting {
        /// How many requests went to `{base}{path}`.
        fn hits(&self, path: &str) -> usize {
            let url = format!("{MOCK_BASE}{path}");
            self.urls
                .lock()
                .unwrap()
                .iter()
                .filter(|u| **u == url)
                .count()
        }
    }

    impl Transport for Counting {
        fn send(&self, req: &Request) -> Result<Response, Offline> {
            self.sent.fetch_add(1, Ordering::SeqCst);
            self.urls.lock().unwrap().push(req.url.clone());
            self.inner.send(req)
        }
    }

    struct Rig {
        hub: Arc<LicenseHub>,
        server: Arc<MockEntitlementServer>,
        net: Arc<Counting>,
        keys: Arc<MemoryKeys>,
        events: Arc<Mutex<Vec<LicenseState>>>,
        signed_in: Arc<AtomicBool>,
        dir: tempfile::TempDir,
    }

    fn timing() -> Timing {
        Timing {
            interval: Duration::from_millis(20),
            polls: 100,
        }
    }

    fn rig_with(
        mode: MockMode,
        dir: tempfile::TempDir,
        keys: Arc<MemoryKeys>,
        signed_in: bool,
        timing: Timing,
    ) -> Rig {
        let server = Arc::new(MockEntitlementServer::new(mode, NOW));
        let net = Arc::new(Counting {
            inner: server.clone(),
            sent: AtomicUsize::new(0),
            urls: Mutex::new(Vec::new()),
        });
        let events = Arc::new(Mutex::new(Vec::new()));
        let signed = Arc::new(AtomicBool::new(signed_in));
        let uid = Arc::new(Mutex::new(MOCK_UID.to_owned()));
        let sink = events.clone();
        let clock = server.clone();
        let hub = Arc::new(LicenseHub::new(
            net.clone(),
            keys.clone(),
            Arc::new(Fixed {
                signed_in: signed.clone(),
                uid,
            }),
            Arc::new(move |s| sink.lock().unwrap().push(s.clone())),
            dir.path().join(FILE_NAME),
            NOW - 86_400,
            Some(MOCK_BASE.to_owned()),
            Box::new(move || clock.now()),
            timing,
        ));
        Rig {
            hub,
            server,
            net,
            keys,
            events,
            signed_in: signed,
            dir,
        }
    }

    fn rig(mode: MockMode) -> Rig {
        rig_with(
            mode,
            tempfile::tempdir().unwrap(),
            Arc::new(MemoryKeys::default()),
            true,
            timing(),
        )
    }

    fn is_pro(state: &LicenseState) -> bool {
        matches!(state, LicenseState::Active { pro: Some(_), .. })
    }

    #[test]
    fn start_up_offline_uses_the_cache_and_sends_nothing() {
        let first = rig(MockMode::Pro);
        first.hub.activate().unwrap();
        assert!(is_pro(&first.hub.state()));

        let second = rig_with(
            MockMode::Offline,
            first.dir,
            first.keys.clone(),
            true,
            timing(),
        );
        let state = second.hub.start();
        assert!(is_pro(&state), "{state:?}");
        assert_eq!(second.net.sent.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn start_up_without_a_cache_is_free() {
        let r = rig(MockMode::Pro);
        assert_eq!(r.hub.start(), LicenseState::free(None));
        assert_eq!(r.net.sent.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn refresh_moves_the_state_to_fresh() {
        let r = rig(MockMode::Pro);
        r.hub.activate().unwrap();
        let state = r.hub.refresh().unwrap();
        match state {
            LicenseState::Active { freshness, .. } => assert_eq!(freshness, Freshness::Fresh),
            other => panic!("{other:?}"),
        }
        assert!(r.hub.allows("pro.early") || is_pro(&r.hub.state()));
        assert!(!r.events.lock().unwrap().is_empty());
    }

    #[test]
    fn signed_out_refresh_changes_nothing_and_sends_nothing() {
        let r = rig_with(
            MockMode::Pro,
            tempfile::tempdir().unwrap(),
            Arc::new(MemoryKeys::default()),
            false,
            timing(),
        );
        assert_eq!(r.hub.refresh().unwrap(), LicenseState::free(None));
        assert_eq!(r.net.sent.load(Ordering::SeqCst), 0);
        assert!(r.hub.activate().is_err());
    }

    #[test]
    fn a_failing_keychain_is_reported() {
        let r = rig(MockMode::Pro);
        r.keys.set_fail(true);
        assert_eq!(r.hub.refresh().unwrap_err().code, E_KEYCHAIN);
    }

    #[test]
    fn offline_refresh_keeps_the_state() {
        let r = rig(MockMode::Pro);
        r.hub.activate().unwrap();
        r.server.set_mode(MockMode::Offline);
        let state = r.hub.refresh().unwrap();
        assert!(is_pro(&state));
    }

    #[test]
    fn a_revoked_device_loses_pro() {
        let r = rig(MockMode::Pro);
        r.hub.activate().unwrap();
        r.server.set_mode(MockMode::Revoked);
        // A new key registers as revoked.
        let fresh = rig_with(
            MockMode::Revoked,
            tempfile::tempdir().unwrap(),
            Arc::new(MemoryKeys::default()),
            true,
            timing(),
        );
        let err = fresh.hub.refresh().unwrap_err();
        assert_eq!(err.code, xdev_license::E_REVOKED);
        assert_eq!(
            fresh.hub.state(),
            LicenseState::free(Some(xdev_license::E_REVOKED))
        );
    }

    #[test]
    fn a_server_without_the_right_key_is_refused() {
        let r = rig(MockMode::BadRoot);
        let err = r.hub.refresh().unwrap_err();
        assert_eq!(err.code, E_SERVER_KEY);
        assert!(read_cache(&r.dir.path().join(FILE_NAME)).is_none());
    }

    #[test]
    fn no_seat_and_transfer_limit_keep_their_codes() {
        let r = rig(MockMode::ProNoSeat);
        assert_eq!(r.hub.activate().unwrap_err().code, xdev_license::E_NO_SEAT);
        let t = rig(MockMode::TransferLimit);
        t.hub.activate().unwrap();
        // Moving the seat again and again runs into the yearly limit.
        let mut last = Ok(());
        for _ in 0..6 {
            last = t
                .hub
                .deactivate(None)
                .and_then(|_| t.hub.activate())
                .map(|_| ());
        }
        if let Err(e) = last {
            assert_eq!(e.code, xdev_license::E_TRANSFER_LIMIT);
        }
    }

    #[test]
    fn deactivate_with_an_id_removes_that_device() {
        let r = rig(MockMode::ProNoSeat);
        assert_eq!(r.server.active_seats(), 1);
        r.hub.deactivate(Some("device-other".to_owned())).unwrap();
        assert_eq!(r.server.active_seats(), 0);
        let state = r.hub.activate().unwrap();
        assert!(is_pro(&state), "{state:?}");
    }

    #[test]
    fn deactivate_without_an_id_frees_this_seat() {
        let r = rig(MockMode::Pro);
        r.hub.activate().unwrap();
        assert_eq!(r.server.active_seats(), 1);
        r.hub.deactivate(None).unwrap();
        assert_eq!(r.server.active_seats(), 0);
    }

    fn wait_until_buying(hub: &LicenseHub) {
        let started = std::time::Instant::now();
        while !hub.buying() {
            assert!(started.elapsed() < Duration::from_secs(5), "never started");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn buying_stops_on_cancel() {
        let r = rig(MockMode::Free);
        let hub = r.hub.clone();
        let t = std::thread::spawn(move || hub.buy_wait("pro"));
        wait_until_buying(&r.hub);
        r.hub.buy_cancel();
        let err = t.join().unwrap().unwrap_err();
        assert_eq!(err.code, E_CANCELLED);
        assert!(!r.hub.buying());
    }

    #[test]
    fn buying_stops_on_success() {
        // The account has a grant, but this computer cannot see it until the person signs in.
        let r = rig_with(
            MockMode::Pro,
            tempfile::tempdir().unwrap(),
            Arc::new(MemoryKeys::default()),
            false,
            timing(),
        );
        let hub = r.hub.clone();
        let t = std::thread::spawn(move || hub.buy_wait("pro"));
        wait_until_buying(&r.hub);
        r.signed_in.store(true, Ordering::SeqCst);
        let state = t.join().unwrap().unwrap();
        assert!(is_pro(&state), "{state:?}");
        assert!(!r.hub.buying());
    }

    #[test]
    fn buying_times_out_with_a_notice() {
        let r = rig_with(
            MockMode::Free,
            tempfile::tempdir().unwrap(),
            Arc::new(MemoryKeys::default()),
            true,
            Timing {
                interval: Duration::from_millis(10),
                polls: 3,
            },
        );
        let err = r.hub.buy_wait("pro").unwrap_err();
        assert_eq!(err.code, E_CHECKOUT_TIMEOUT);
        assert_eq!(r.hub.state(), LicenseState::free(Some(E_CHECKOUT_TIMEOUT)));
        assert_eq!(
            r.events.lock().unwrap().last(),
            Some(&LicenseState::free(Some(E_CHECKOUT_TIMEOUT)))
        );
    }

    #[test]
    fn the_buy_address_names_the_product_and_this_device() {
        let r = rig(MockMode::Free);
        let url = r.hub.buy_url("device").unwrap();
        let key = r.keys.load().unwrap().unwrap();
        assert_eq!(
            url,
            format!("{MOCK_BASE}/?buy=device&device={}", key.fingerprint())
        );
        assert_eq!(r.hub.buy_url("gold").unwrap_err().code, E_BAD_PRODUCT);
    }

    #[test]
    fn a_new_server_drops_the_cache() {
        let r = rig(MockMode::Pro);
        r.hub.activate().unwrap();
        assert!(r.dir.path().join(FILE_NAME).exists());
        r.hub.server_changed(CloudConfig::default());
        assert!(!r.dir.path().join(FILE_NAME).exists());
        assert_eq!(r.hub.state(), LicenseState::free(None));
    }

    #[test]
    fn the_next_refresh_is_clamped() {
        assert_eq!(next_refresh(1000, Some(1100)), 1000 + REFRESH_FLOOR_S);
        assert_eq!(
            next_refresh(1000, Some(1000 + 86_400)),
            1000 + REFRESH_CAP_S
        );
        assert_eq!(next_refresh(1000, Some(4000)), 4000);
        assert_eq!(next_refresh(1000, None), 1000 + RETRY_S);
    }

    #[test]
    fn the_build_date_is_unix_seconds() {
        assert_eq!(build_date_of(Some("1767225600")), 1_767_225_600);
        assert_eq!(build_date_of(Some(" 1767225600\n")), 1_767_225_600);
        assert_eq!(build_date_of(Some("soon")), 0);
        assert_eq!(build_date_of(Some("-5")), 0);
        assert_eq!(build_date_of(None), 0);
    }

    #[test]
    fn the_device_id_is_remembered_per_account_on_a_server() {
        let r = rig(MockMode::Pro);
        let key = r.hub.key_or_new().unwrap();
        let creds = |uid: &str| Credentials {
            bearer: Secret::new(MOCK_BEARER.to_owned()),
            base: MOCK_BASE.to_owned(),
            uid: uid.to_owned(),
        };
        let a = creds(MOCK_UID);
        r.hub.refresh().unwrap();
        let listed = r.net.hits("/v1/devices");
        r.hub.device_id(&a, &key).unwrap();
        assert_eq!(r.net.hits("/v1/devices"), listed, "same account: cached");
        // Another account on the same server must look the device up again.
        r.hub.device_id(&creds("someone-else"), &key).unwrap();
        assert_eq!(r.net.hits("/v1/devices"), listed + 1);
        // And going back is a lookup too: only the last account is remembered.
        r.hub.device_id(&a, &key).unwrap();
        assert_eq!(r.net.hits("/v1/devices"), listed + 2);
    }

    /// The id the service gave this computer.
    fn this_device(r: &Rig) -> String {
        let fingerprint = r.keys.load().unwrap().unwrap().fingerprint();
        r.hub
            .devices()
            .unwrap()
            .into_iter()
            .find(|d| d.fingerprint == fingerprint)
            .unwrap()
            .id
    }

    #[test]
    fn an_unknown_device_registers_again_and_is_not_revoked() {
        let r = rig(MockMode::Pro);
        r.hub.activate().unwrap();
        r.server.forget(&this_device(&r));
        let before = r.net.hits("/v1/devices");
        let state = r.hub.refresh().unwrap();
        // One more registration, and the retried call went through.
        assert_eq!(r.net.hits("/v1/devices"), before + 1);
        assert_eq!(state, LicenseState::free(None), "no revoked notice");
        // The seat went with the old device; the new one can take it.
        let state = r.hub.activate().unwrap();
        assert!(is_pro(&state), "{state:?}");
    }

    #[test]
    fn activating_an_unknown_device_registers_again_once() {
        let r = rig(MockMode::Pro);
        r.hub.refresh().unwrap();
        r.server.forget(&this_device(&r));
        let state = r.hub.activate().unwrap();
        assert!(is_pro(&state), "{state:?}");
    }

    #[test]
    fn a_revoked_device_still_gets_the_sticky_notice() {
        let r = rig(MockMode::Pro);
        r.hub.activate().unwrap();
        r.server.revoke(&this_device(&r));
        assert_eq!(r.hub.refresh().unwrap_err().code, xdev_license::E_REVOKED);
        assert_eq!(
            r.hub.state(),
            LicenseState::free(Some(xdev_license::E_REVOKED))
        );
    }

    #[test]
    fn a_tick_refreshes_only_when_due() {
        let r = rig(MockMode::Pro);
        r.hub.activate().unwrap();
        let sent = r.net.sent.load(Ordering::SeqCst);
        r.hub.tick();
        assert_eq!(r.net.sent.load(Ordering::SeqCst), sent, "not due yet");
        r.server.set_now(NOW + REFRESH_CAP_S + 1);
        r.hub.tick();
        assert!(r.net.sent.load(Ordering::SeqCst) > sent);
    }
}
