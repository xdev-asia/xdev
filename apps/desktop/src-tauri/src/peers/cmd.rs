//! The Tauri side of paired computers: the managed `PeersHub`, the
//! `peer_*` commands and the app's `HostEnv`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{RecvTimeoutError, channel};
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde_json::{Value, json};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Listener as _, Manager, State};
use xdev_link::{
    Discover, Discovery, Handle, HostKey, JoinTarget, KeyringStore, LinkBind, LinkError, ListenCfg,
    Listener, Nearby, NearbyHost, PairOfferView, PairPending, PeerRole, PeerStore, PeerTerm,
    PeerTermAttached, PeerTermState, PeerView, PeersState, RpcError, SystemClock, WsConnect,
};

use super::{ACTION_WAIT, CALL_WAIT, Core, HostEnv, LocalProject, lock};
use crate::commands::{AppState, CmdError};
use crate::settings::{CHANGED_EVENT, LinkSettings, SettingsSection};
use crate::settings_store;

/// The codes a peer command may answer with.
const CODES: &[&str] = &[
    "pair_code",
    "pair_rejected",
    "pair_busy",
    "link_port",
    "peer_offline",
    "peer_role",
    "peer_denied",
    "no_term",
    "no_project",
    "rate_limited",
    "bad_request",
    "unsupported",
    "key_store",
    "peer_store",
];

pub(crate) fn code_of(code: &str) -> &'static str {
    CODES
        .iter()
        .find(|c| **c == code)
        .copied()
        .unwrap_or("peer_offline")
}

fn err(e: RpcError) -> CmdError {
    CmdError {
        code: code_of(&e.code),
        detail: None,
    }
}

fn link_err(e: &LinkError) -> CmdError {
    err(super::rpc(e))
}

fn off() -> CmdError {
    CmdError {
        code: "peer_offline",
        detail: Some("paired computers are off".into()),
    }
}

/// Discovery once the listener has its port; nothing before.
#[derive(Default)]
struct LateDiscover(RwLock<Option<Arc<Discovery>>>);

impl LateDiscover {
    fn get(&self) -> Option<Arc<Discovery>> {
        self.0
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

impl Discover for LateDiscover {
    fn set_pairing(&self, name: Option<&str>) -> Result<(), LinkError> {
        self.get().map_or(Ok(()), |d| d.set_pairing(name))
    }

    fn pairing(&self) -> bool {
        self.get().is_some_and(|d| d.pairing())
    }

    fn browse(&self) -> Result<std::sync::mpsc::Receiver<Nearby>, LinkError> {
        match self.get() {
            Some(d) => d.browse(),
            None => Ok(channel().1),
        }
    }

    fn resolve(&self, host_id: &str) -> Vec<std::net::SocketAddr> {
        self.get().map(|d| d.resolve(host_id)).unwrap_or_default()
    }
}

struct Running {
    core: Arc<Core>,
    handle: Handle,
    discovery: Arc<LateDiscover>,
    cfg: LinkSettings,
    stop: Arc<AtomicBool>,
}

/// Managed state: the link while it is on.
#[derive(Default)]
pub struct PeersHub {
    running: Mutex<Option<Running>>,
}

impl PeersHub {
    fn core(&self) -> Option<Arc<Core>> {
        lock(&self.running).as_ref().map(|r| r.core.clone())
    }

    fn need(&self) -> Result<Arc<Core>, CmdError> {
        self.core().ok_or_else(off)
    }

    /// Matches the running link to the `link` settings: starts, stops or
    /// restarts it.
    pub fn sync(&self, app: &AppHandle) -> Result<(), CmdError> {
        let want = settings_store::read(app).link;
        let mut running = lock(&self.running);
        let same = running
            .as_ref()
            .is_some_and(|r| r.cfg.bind == want.bind && r.cfg.port == want.port && want.enabled);
        if same {
            if let Some(r) = running.as_mut() {
                r.cfg = want;
            }
            return Ok(());
        }
        if let Some(r) = running.take() {
            stop_running(r);
        }
        if want.enabled {
            *running = Some(start_running(app, want)?);
        }
        drop(running);
        emit_changed(app);
        Ok(())
    }

    pub fn stop(&self) {
        if let Some(r) = lock(&self.running).take() {
            stop_running(r);
        }
    }

    fn state(&self, app: &AppHandle) -> PeersState {
        let cfg = settings_store::read(app).link;
        let running = lock(&self.running);
        match running.as_ref() {
            Some(r) => PeersState {
                enabled: true,
                bind: r.cfg.bind,
                port: Some(r.handle.port()),
                host_id: r.core.host_id(),
                host_name: r.core.env.host_name(),
                fingerprint: r.core.key.fingerprint(),
                pairing: r.core.pairing(),
            },
            None => PeersState {
                enabled: false,
                bind: cfg.bind,
                port: None,
                host_id: String::new(),
                host_name: host_name(app),
                fingerprint: String::new(),
                pairing: false,
            },
        }
    }
}

fn stop_running(r: Running) {
    r.stop.store(true, Ordering::SeqCst);
    super::set_current(None);
    r.handle.stop();
    if let Some(d) = r.discovery.get() {
        d.stop();
    }
    r.core.stop();
}

fn start_running(app: &AppHandle, cfg: LinkSettings) -> Result<Running, CmdError> {
    let data = crate::accounts::data_dir(&app.state::<AppState>())?.to_path_buf();
    let key = Arc::new(HostKey::load_or_create(&KeyringStore).map_err(|e| link_err(&e))?);
    let store = Arc::new(PeerStore::open(&data.join("peers.json")).map_err(|e| link_err(&e))?);
    let discovery = Arc::new(LateDiscover::default());
    let env = Arc::new(AppEnv { app: app.clone() });
    let core = Core::new(
        env,
        key.clone(),
        store.clone(),
        discovery.clone(),
        Arc::new(SystemClock),
        Box::new(WsConnect),
    );
    let (tx, rx) = channel();
    let listen = ListenCfg {
        bind: cfg.bind,
        port_range: cfg.port..=cfg.port.saturating_add(15),
        ..ListenCfg::default()
    };
    let handle = Listener::start(
        listen,
        key.clone(),
        store,
        core.window.clone(),
        core.serve(),
        tx,
    )
    .map_err(|e| link_err(&e))?;
    core.set_host(Some(handle.host().clone()));
    if let Ok(d) = Discovery::start(&key.host_id(), handle.port(), cfg.bind) {
        *discovery.0.write().unwrap_or_else(PoisonError::into_inner) = Some(Arc::new(d));
    } else {
        crate::applog::warn("peers", "discovery did not start");
    }
    let stop = Arc::new(AtomicBool::new(false));
    {
        let core = core.clone();
        std::thread::spawn(move || {
            for ev in rx {
                core.on_event(ev);
            }
        });
    }
    {
        let core = Arc::downgrade(&core);
        let stop = stop.clone();
        std::thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_secs(5));
                match core.upgrade() {
                    Some(c) => c.reap_idle(),
                    None => return,
                }
            }
        });
    }
    super::set_current(Some(core.clone()));
    Ok(Running {
        core,
        handle,
        discovery,
        cfg,
        stop,
    })
}

fn emit_changed(app: &AppHandle) {
    let state = app.state::<PeersHub>().state(app);
    let _ = app.emit("peers://changed", state);
}

fn host_name(app: &AppHandle) -> String {
    crate::network::machine_name(&settings_store::read(app).network)
}

/// Starts the link when the settings have it on, and follows later changes.
pub fn start(app: &AppHandle) {
    let handle = app.clone();
    app.listen_any(CHANGED_EVENT, move |e| {
        if e.payload().contains("\"link\"") {
            let app = handle.clone();
            std::thread::spawn(move || {
                if let Err(e) = app.state::<PeersHub>().sync(&app) {
                    crate::applog::warn("peers", e.code);
                }
            });
        }
    });
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = app.state::<PeersHub>().sync(&app) {
            crate::applog::warn("peers", e.code);
        }
    });
}

// ---- the app's HostEnv ----

struct AppEnv {
    app: AppHandle,
}

impl AppEnv {
    fn tabs(&self) -> Vec<crate::cli_verbs::TabReport> {
        self.app.state::<crate::cli_verbs::CliHub>().board.tabs().0
    }

    fn registry(&self) -> Option<xdev_workspace::Registry> {
        let state = self.app.state::<AppState>();
        let data = crate::accounts::data_dir(&state).ok()?;
        xdev_workspace::Registry::load(data).ok()
    }
}

fn state_of(status: &str) -> PeerTermState {
    match status {
        "working" => PeerTermState::Running,
        "needs-you" => PeerTermState::NeedsInput,
        "done" => PeerTermState::Done,
        _ => PeerTermState::Idle,
    }
}

impl HostEnv for AppEnv {
    fn host_name(&self) -> String {
        host_name(&self.app)
    }

    fn xid(&self) -> Option<String> {
        match self.app.state::<crate::xdev_id::XdevIdHub>().state() {
            xdev_id::XdevIdState::SignedIn { user } => Some(super::xid_of(&user.email)),
            _ => None,
        }
    }

    fn confirm_each(&self) -> bool {
        settings_store::read(&self.app).link.confirm_each
    }

    fn projects(&self) -> Vec<LocalProject> {
        self.registry()
            .map(|r| {
                r.repos
                    .into_iter()
                    .map(|p| LocalProject {
                        id: p.id,
                        name: p.short_name,
                        path: p.path.to_string_lossy().into_owned(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn terms(&self) -> Vec<PeerTerm> {
        let reg = self.registry();
        let project_of = |path: &str| -> Option<String> {
            let reg = reg.as_ref()?;
            let p = std::path::Path::new(path);
            reg.worktrees
                .iter()
                .find(|w| w.path == p)
                .map(|w| w.repo_id.clone())
                .or_else(|| {
                    reg.repos
                        .iter()
                        .find(|r| p.starts_with(&r.path))
                        .map(|r| r.id.clone())
                })
        };
        self.tabs()
            .into_iter()
            .filter(|t| !t.exited)
            .map(|t| PeerTerm {
                title: t.title.clone().unwrap_or_else(|| t.id.clone()),
                agent: t.cli.clone().or_else(|| t.agent.then(|| t.profile.clone())),
                state: state_of(&t.status),
                project_id: project_of(&t.worktree),
                id: t.id,
            })
            .collect()
    }

    fn write(&self, term: &str, data: &[u8]) -> Result<(), RpcError> {
        self.app
            .state::<crate::pty::Ptys>()
            .with(term, |s| s.write(data.to_vec()))
            .map_err(|_| RpcError::code("no_term"))
    }

    fn kill(&self, term: &str) -> Result<(), RpcError> {
        let app = &self.app;
        crate::pty::pty_kill(
            app.state(),
            app.state(),
            app.state(),
            app.state(),
            app.state(),
            term.to_owned(),
        );
        Ok(())
    }

    fn open_tab(
        &self,
        project: &LocalProject,
        profile: &str,
        prompt: Option<String>,
        title: String,
    ) -> Result<PeerTerm, RpcError> {
        crate::orchestration::open_for_peer(&self.app, &project.path, profile, prompt, &title)
            .map(|tab| PeerTerm {
                id: tab,
                title,
                agent: (profile != "shell").then(|| profile.to_owned()),
                state: PeerTermState::Running,
                project_id: Some(project.id.clone()),
            })
            .map_err(RpcError::code)
    }

    fn hand_off(
        &self,
        from_host: &str,
        to_tab: &str,
        from_title: &str,
        body: &str,
    ) -> Result<Value, RpcError> {
        crate::orchestration::hand_off_from_peer(&self.app, from_host, to_tab, from_title, body)
            .map_err(RpcError::code)
    }

    fn emit(&self, event: &str, payload: Value) {
        let _ = self.app.emit(event, payload);
    }

    fn changed(&self) {
        let app = self.app.clone();
        std::thread::spawn(move || emit_changed(&app));
    }
}

// ---- commands ----

#[tauri::command(async)]
pub fn peers_state(app: AppHandle, hub: State<'_, PeersHub>) -> PeersState {
    hub.state(&app)
}

#[tauri::command(async)]
pub fn peers_set_enabled(
    app: AppHandle,
    hub: State<'_, PeersHub>,
    on: bool,
) -> Result<PeersState, CmdError> {
    settings_store::write(&app, &[SettingsSection::Link], |s| s.link.enabled = on)?;
    hub.sync(&app)?;
    Ok(hub.state(&app))
}

#[tauri::command(async)]
pub fn peers_list(hub: State<'_, PeersHub>) -> Vec<PeerView> {
    hub.core().map(|c| c.list()).unwrap_or_default()
}

/// Computers that announce themselves here; more arrive as `peers://nearby`.
#[tauri::command(async)]
pub fn peers_nearby(app: AppHandle, hub: State<'_, PeersHub>) -> Result<Vec<NearbyHost>, CmdError> {
    let core = hub.need()?;
    let rx = core.discover.browse().map_err(|e| link_err(&e))?;
    let seen: Arc<Mutex<HashMap<String, Nearby>>> = Arc::default();
    let view = {
        let core = core.clone();
        let seen = seen.clone();
        move || -> Vec<NearbyHost> {
            let own = core.host_id();
            let mut hosts: Vec<NearbyHost> = lock(&seen)
                .values()
                .filter(|n| n.host_id != own)
                .map(|n| NearbyHost {
                    host_id: n.host_id.clone(),
                    name: n.name.clone(),
                    pairing: n.pairing,
                    paired: core.store.find_by_id(&n.host_id).is_some(),
                })
                .collect();
            hosts.sort_by(|a, b| a.host_id.cmp(&b.host_id));
            hosts
        }
    };
    let first = Instant::now() + Duration::from_millis(1500);
    while let Some(left) = first.checked_duration_since(Instant::now()) {
        match rx.recv_timeout(left) {
            Ok(n) => {
                lock(&seen).insert(n.host_id.clone(), n);
            }
            Err(RecvTimeoutError::Timeout) => break,
            Err(RecvTimeoutError::Disconnected) => return Ok(view()),
        }
    }
    let now = view();
    std::thread::spawn(move || {
        let until = Instant::now() + Duration::from_secs(30);
        while let Some(left) = until.checked_duration_since(Instant::now()) {
            match rx.recv_timeout(left) {
                Ok(n) => {
                    lock(&seen).insert(n.host_id.clone(), n);
                    let _ = app.emit("peers://nearby", view());
                }
                Err(_) => return,
            }
        }
    });
    Ok(now)
}

/// Opens the pair window on `bind`, turning the link on when it is off.
#[tauri::command(async)]
pub fn peer_pair_start(
    app: AppHandle,
    hub: State<'_, PeersHub>,
    bind: LinkBind,
) -> Result<PairOfferView, CmdError> {
    let cfg = settings_store::read(&app).link;
    if !cfg.enabled || cfg.bind != bind {
        settings_store::write(&app, &[SettingsSection::Link], |s| {
            s.link.enabled = true;
            s.link.bind = bind;
        })?;
        hub.sync(&app)?;
    }
    let (core, port) = {
        let running = lock(&hub.running);
        let r = running.as_ref().ok_or_else(off)?;
        (r.core.clone(), r.handle.port())
    };
    let candidates = xdev_link::net::candidates(bind, port)
        .iter()
        .map(std::net::SocketAddr::to_string)
        .collect();
    core.pair_start(candidates).map_err(err)
}

#[tauri::command(async)]
pub fn peer_pair_cancel(hub: State<'_, PeersHub>) {
    if let Some(core) = hub.core() {
        core.pair_cancel();
    }
}

#[tauri::command(async)]
pub fn peer_pair_join(
    hub: State<'_, PeersHub>,
    target: JoinTarget,
    code: String,
    grant_back: bool,
) -> Result<PairPending, CmdError> {
    hub.need()?
        .pair_join(&target, &code, grant_back)
        .map_err(err)
}

#[tauri::command(async)]
pub fn peer_pair_confirm(
    hub: State<'_, PeersHub>,
    request_id: String,
    accept: bool,
    role: PeerRole,
) -> Result<(), CmdError> {
    hub.need()?
        .pair_confirm(&request_id, accept, role)
        .map_err(err)
}

#[tauri::command(async)]
pub fn peer_set_role(
    hub: State<'_, PeersHub>,
    peer_id: String,
    role: PeerRole,
) -> Result<PeerView, CmdError> {
    hub.need()?.set_role(&peer_id, role).map_err(err)
}

#[tauri::command(async)]
pub fn peer_rename(
    hub: State<'_, PeersHub>,
    peer_id: String,
    name: String,
) -> Result<PeerView, CmdError> {
    hub.need()?.rename(&peer_id, &name).map_err(err)
}

#[tauri::command(async)]
pub fn peer_remove(hub: State<'_, PeersHub>, peer_id: String) -> Result<(), CmdError> {
    hub.need()?.remove(&peer_id).map_err(err)
}

fn parse<T: serde::de::DeserializeOwned>(v: Value) -> Result<T, CmdError> {
    serde_json::from_value(v).map_err(|_| CmdError {
        code: "bad_request",
        detail: None,
    })
}

#[tauri::command(async)]
pub fn peer_projects(
    hub: State<'_, PeersHub>,
    peer_id: String,
) -> Result<Vec<xdev_link::PeerProject>, CmdError> {
    let v = hub
        .need()?
        .call(&peer_id, "projects.list", json!({}), CALL_WAIT)
        .map_err(err)?;
    parse(v)
}

#[tauri::command(async)]
pub fn peer_terms(hub: State<'_, PeersHub>, peer_id: String) -> Result<Vec<PeerTerm>, CmdError> {
    let v = hub
        .need()?
        .call(&peer_id, "terms.list", json!({}), CALL_WAIT)
        .map_err(err)?;
    parse(v)
}

#[tauri::command(async)]
pub fn peer_term_attach(
    hub: State<'_, PeersHub>,
    peer_id: String,
    term_id: String,
    out: Channel<InvokeResponseBody>,
) -> Result<PeerTermAttached, CmdError> {
    let sink = Box::new(move |bytes: &[u8]| {
        let _ = out.send(InvokeResponseBody::Raw(bytes.to_vec()));
    });
    hub.need()?.attach(&peer_id, &term_id, sink).map_err(err)
}

#[tauri::command(async)]
pub fn peer_term_detach(hub: State<'_, PeersHub>, peer_id: String, term_id: String) {
    if let Some(core) = hub.core() {
        core.detach(&peer_id, &term_id);
    }
}

#[tauri::command(async)]
pub fn peer_term_write(
    hub: State<'_, PeersHub>,
    peer_id: String,
    term_id: String,
    data: Vec<u8>,
) -> Result<(), CmdError> {
    if data.len() > super::host::WRITE_MAX {
        return Err(CmdError {
            code: "bad_request",
            detail: None,
        });
    }
    let data_b64 = base64::engine::general_purpose::STANDARD.encode(&data);
    hub.need()?
        .call(
            &peer_id,
            "term.write",
            json!({ "id": term_id, "data_b64": data_b64 }),
            ACTION_WAIT,
        )
        .map(|_| ())
        .map_err(err)
}

#[tauri::command(async)]
pub fn peer_agent_start(
    hub: State<'_, PeersHub>,
    peer_id: String,
    project_id: String,
    profile_id: String,
    prompt: Option<String>,
) -> Result<PeerTerm, CmdError> {
    let v = hub
        .need()?
        .call(
            &peer_id,
            "agent.start",
            json!({ "project_id": project_id, "profile_id": profile_id, "prompt": prompt }),
            ACTION_WAIT,
        )
        .map_err(err)?;
    parse(v)
}

#[tauri::command(async)]
pub fn peer_confirm_reply(hub: State<'_, PeersHub>, request_id: String, allow: bool) {
    if let Some(core) = hub.core() {
        super::host::reply(&core, &request_id, allow);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_codes_read_as_offline() {
        assert_eq!(code_of("peer_role"), "peer_role");
        assert_eq!(code_of("closed"), "peer_offline");
        assert_eq!(
            base64::engine::general_purpose::STANDARD.encode(b"hi"),
            "aGk="
        );
    }
}
