//! What this computer answers a paired computer (`peer/1`).
//!
//! Every action runs the same checks, in order: the role, the rate limit,
//! `confirm_each` (a click here, 60 s at most), then the action, then a
//! `peers://activity` toast for what changes something.

use std::collections::HashMap;
use std::sync::mpsc::{RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use serde_json::{Value, json};
use xdev_link::{
    Clock, Limits, Link, PeerActivity, PeerConfirm, PeerCtx, PeerProject, PeerRole, PeerTerm,
    RpcError,
};

use super::{Core, SEQ_LEN, lock, tap};

/// The most one `term.write` carries.
pub(crate) const WRITE_MAX: usize = 4096;
/// How long a `confirm_each` question waits for a click.
pub(crate) const CONFIRM_MS: u64 = 60_000;
/// A `typed` toast per tab at most this often.
pub(crate) const TYPED_EVERY_MS: u64 = 10_000;
/// An allowed `term.write` is not asked again for this tab this long.
pub(crate) const WRITE_ALLOW_MS: u64 = 10 * 60_000;
/// Output bytes per stream frame, after the seq header.
const FRAME_BYTES: usize = 16 * 1024;

/// A project a paired computer may see.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LocalProject {
    pub id: String,
    pub name: String,
    pub path: String,
}

/// What the app gives the host side. Tests use a fake.
pub(crate) trait HostEnv: Send + Sync {
    fn host_name(&self) -> String;
    /// The hashed xDev ID while signed in.
    fn xid(&self) -> Option<String>;
    fn confirm_each(&self) -> bool;
    fn projects(&self) -> Vec<LocalProject>;
    fn terms(&self) -> Vec<PeerTerm>;
    fn size(&self, _term: &str) -> (u16, u16) {
        (80, 24)
    }
    fn write(&self, term: &str, data: &[u8]) -> Result<(), RpcError>;
    fn kill(&self, term: &str) -> Result<(), RpcError>;
    /// Opens a tab in `project` running `profile` (`shell` for a plain one).
    fn open_tab(
        &self,
        project: &LocalProject,
        profile: &str,
        prompt: Option<String>,
        title: String,
    ) -> Result<PeerTerm, RpcError>;
    /// Types a hand-off from computer `from_host` into tab `to_tab`.
    fn hand_off(
        &self,
        from_host: &str,
        to_tab: &str,
        from_title: &str,
        body: &str,
    ) -> Result<Value, RpcError>;
    fn emit(&self, event: &str, payload: Value);
    fn changed(&self);
}

/// A remote watcher of one of this computer's tabs.
struct Sub {
    term: String,
    wid: u64,
    link: Arc<Link>,
}

/// The host side's state, inside `Core`.
pub(crate) struct HostSide {
    clock: Arc<dyn Clock>,
    confirms: Mutex<HashMap<String, Sender<bool>>>,
    limits: Mutex<HashMap<String, Limits>>,
    typed: Mutex<HashMap<(String, String), u64>>,
    allowed: Mutex<HashMap<(String, String), u64>>,
    subs: Mutex<HashMap<(String, u32), Sub>>,
}

impl HostSide {
    pub(crate) fn new(clock: Arc<dyn Clock>) -> HostSide {
        HostSide {
            clock,
            confirms: Mutex::default(),
            limits: Mutex::default(),
            typed: Mutex::default(),
            allowed: Mutex::default(),
            subs: Mutex::default(),
        }
    }

    fn now(&self) -> u64 {
        self.clock.now_ms()
    }
}

fn bad() -> RpcError {
    RpcError::code("bad_request")
}

fn str_param<'a>(p: &'a Value, k: &str) -> Result<&'a str, RpcError> {
    p.get(k)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(bad)
}

/// Answers one call from `peer`.
pub(crate) fn call(core: &Core, peer: &PeerCtx, m: &str, p: Value) -> Result<Value, RpcError> {
    match m {
        "hello" => Ok(core.hello_value(Some(peer.role))),
        "bye" => Ok(Value::Null),
        "projects.list" => {
            peer.require(PeerRole::Viewer)?;
            let admin = peer.role.allows(PeerRole::Admin);
            let list: Vec<PeerProject> = core
                .env
                .projects()
                .into_iter()
                .map(|p| PeerProject {
                    id: p.id,
                    name: p.name,
                    path: admin.then_some(p.path),
                })
                .collect();
            Ok(json!(list))
        }
        "terms.list" => {
            peer.require(PeerRole::Viewer)?;
            Ok(json!(core.env.terms()))
        }
        "term.attach" => {
            peer.require(PeerRole::Viewer)?;
            attach(core, peer, &p)
        }
        "term.detach" => {
            peer.require(PeerRole::Viewer)?;
            detach(core, peer, &p);
            Ok(Value::Null)
        }
        "term.write" => {
            peer.require(PeerRole::Operator)?;
            write(core, peer, &p)
        }
        "agent.start" => {
            peer.require(PeerRole::Operator)?;
            let project = project(core, &p)?;
            let profile = str_param(&p, "profile_id")?.to_owned();
            let prompt = p
                .get("prompt")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(str::to_owned);
            limit_rpc(core, peer)?;
            confirm(core, peer, "start", &project.name)?;
            let title = format!("{} (from {})", profile, peer.name);
            let term = core.env.open_tab(&project, &profile, prompt, title)?;
            activity(core, peer, "started", &term.title);
            Ok(json!(term))
        }
        "shell.open" => {
            peer.require(PeerRole::Admin)?;
            let project = project(core, &p)?;
            limit_rpc(core, peer)?;
            confirm(core, peer, "shell", &project.name)?;
            let title = format!("shell (from {})", peer.name);
            let term = core.env.open_tab(&project, "shell", None, title)?;
            activity(core, peer, "started", &term.title);
            Ok(json!(term))
        }
        "term.kill" => {
            peer.require(PeerRole::Admin)?;
            let id = str_param(&p, "id")?;
            let title = term_title(core, id)?;
            limit_rpc(core, peer)?;
            confirm(core, peer, "kill", &title)?;
            core.env.kill(id)?;
            activity(core, peer, "killed", &title);
            Ok(Value::Null)
        }
        "mail.handoff" => {
            peer.require(PeerRole::Operator)?;
            let to = str_param(&p, "to_tab")?;
            let from_title = str_param(&p, "from_title")?;
            let body = p.get("body").and_then(Value::as_str).ok_or_else(bad)?;
            limit_rpc(core, peer)?;
            confirm(core, peer, "handoff", to)?;
            let v = core
                .env
                .hand_off(&core.host_id_of(peer), to, from_title, body)?;
            activity(core, peer, "handed_off", to);
            Ok(v)
        }
        _ => Err(RpcError::code("unsupported")),
    }
}

impl Core {
    /// The host id of the computer on the other end of `peer`.
    fn host_id_of(&self, peer: &PeerCtx) -> String {
        xdev_link::identity::host_id_of(&peer.remote_pub)
    }
}

fn project(core: &Core, p: &Value) -> Result<super::LocalProject, RpcError> {
    let id = str_param(p, "project_id")?;
    core.env
        .projects()
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| RpcError::code("no_project"))
}

fn term_title(core: &Core, id: &str) -> Result<String, RpcError> {
    core.env
        .terms()
        .into_iter()
        .find(|t| t.id == id)
        .map(|t| t.title)
        .ok_or_else(|| RpcError::code("no_term"))
}

fn limit_rpc(core: &Core, peer: &PeerCtx) -> Result<(), RpcError> {
    let side = &core.side;
    let mut limits = lock(&side.limits);
    let l = limits
        .entry(peer.peer_id.clone())
        .or_insert_with(|| Limits::new(side.clock.clone()));
    if l.allow_rpc() {
        Ok(())
    } else {
        Err(RpcError::code("rate_limited"))
    }
}

fn limit_input(core: &Core, peer: &PeerCtx) -> Result<(), RpcError> {
    let side = &core.side;
    let mut limits = lock(&side.limits);
    let l = limits
        .entry(peer.peer_id.clone())
        .or_insert_with(|| Limits::new(side.clock.clone()));
    if l.allow_input() {
        Ok(())
    } else {
        Err(RpcError::code("rate_limited"))
    }
}

fn activity(core: &Core, peer: &PeerCtx, action: &str, target: &str) {
    core.env.emit(
        "peers://activity",
        json!(PeerActivity {
            peer: peer.name.clone(),
            action: action.to_owned(),
            target: target.to_owned(),
        }),
    );
}

/// With `confirm_each` on, asks here and waits for the click; `peer_denied`
/// on a no or after `CONFIRM_MS`.
fn confirm(core: &Core, peer: &PeerCtx, action: &str, target: &str) -> Result<(), RpcError> {
    if !core.env.confirm_each() {
        return Ok(());
    }
    let side = &core.side;
    let request_id = uuid::Uuid::new_v4().simple().to_string();
    let (tx, rx) = channel();
    lock(&side.confirms).insert(request_id.clone(), tx);
    core.env.emit(
        "peers://confirm",
        json!(PeerConfirm {
            request_id: request_id.clone(),
            peer: peer.name.clone(),
            action: action.to_owned(),
            target: target.to_owned(),
        }),
    );
    let deadline = side.now() + CONFIRM_MS;
    let allowed = loop {
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(allow) => break allow,
            Err(RecvTimeoutError::Disconnected) => break false,
            Err(RecvTimeoutError::Timeout) if side.now() >= deadline => break false,
            Err(RecvTimeoutError::Timeout) => {}
        }
    };
    lock(&side.confirms).remove(&request_id);
    if allowed {
        Ok(())
    } else {
        Err(RpcError::code("peer_denied"))
    }
}

/// The click on a `peers://confirm`. `false` when it is no longer waiting.
pub(crate) fn reply(core: &Core, request_id: &str, allow: bool) -> bool {
    lock(&core.side.confirms)
        .remove(request_id)
        .is_some_and(|tx| tx.send(allow).is_ok())
}

fn write(core: &Core, peer: &PeerCtx, p: &Value) -> Result<Value, RpcError> {
    let id = str_param(p, "id")?;
    let data = base64::engine::general_purpose::STANDARD
        .decode(p.get("data_b64").and_then(Value::as_str).ok_or_else(bad)?)
        .map_err(|_| bad())?;
    if data.len() > WRITE_MAX {
        return Err(bad());
    }
    let title = term_title(core, id)?;
    limit_input(core, peer)?;
    let key = (peer.peer_id.clone(), id.to_owned());
    let now = core.side.now();
    let remembered = lock(&core.side.allowed)
        .get(&key)
        .is_some_and(|until| now < *until);
    if !remembered && core.env.confirm_each() {
        confirm(core, peer, "type", &title)?;
        lock(&core.side.allowed).insert(key.clone(), core.side.now() + WRITE_ALLOW_MS);
    }
    core.env.write(id, &data)?;
    let toast = {
        let mut typed = lock(&core.side.typed);
        let due = typed
            .get(&key)
            .is_none_or(|last| now.saturating_sub(*last) >= TYPED_EVERY_MS);
        if due {
            typed.insert(key, now);
        }
        due
    };
    if toast {
        activity(core, peer, "typed", &title);
    }
    Ok(Value::Null)
}

/// Starts sending tab `id` to the caller on its `stream`, from `from_seq`.
fn attach(core: &Core, peer: &PeerCtx, p: &Value) -> Result<Value, RpcError> {
    let id = str_param(p, "id")?.to_owned();
    let stream = p
        .get("stream")
        .and_then(Value::as_u64)
        .and_then(|s| u32::try_from(s).ok())
        .ok_or_else(bad)?;
    let from_seq = p.get("from_seq").and_then(Value::as_u64).unwrap_or(0);
    let link = core
        .open_link(&peer.peer_id)
        .ok_or_else(|| RpcError::code("peer_offline"))?;
    let key = (peer.peer_id.clone(), stream);
    if let Some(old) = lock(&core.side.subs).remove(&key) {
        tap::unsubscribe(&old.term, old.wid);
    }
    let out = link.clone();
    let term = id.clone();
    let watcher: tap::Watcher = Box::new(move |f| match f {
        tap::Frame::Output { seq, bytes } => {
            let mut at = seq;
            for chunk in bytes.chunks(FRAME_BYTES) {
                let mut frame = Vec::with_capacity(SEQ_LEN + chunk.len());
                frame.extend_from_slice(&at.to_be_bytes());
                frame.extend_from_slice(chunk);
                let _ = out.send_stream(stream, &frame);
                at += chunk.len() as u64;
            }
        }
        tap::Frame::Exit => {
            let _ = out.notify(
                "term.closed",
                json!({ "stream": stream, "id": term, "reason": "exited" }),
            );
        }
    });
    let (wid, _) =
        tap::subscribe(&id, from_seq, watcher).ok_or_else(|| RpcError::code("no_term"))?;
    lock(&core.side.subs).insert(
        key,
        Sub {
            term: id.clone(),
            wid,
            link,
        },
    );
    let (cols, rows) = core.env.size(&id);
    Ok(json!({ "stream": stream, "cols": cols, "rows": rows }))
}

fn detach(core: &Core, peer: &PeerCtx, p: &Value) {
    let id = p.get("id").and_then(Value::as_str).unwrap_or_default();
    let stream = p.get("stream").and_then(Value::as_u64);
    let gone: Vec<Sub> = {
        let mut subs = lock(&core.side.subs);
        let keys: Vec<(String, u32)> = subs
            .iter()
            .filter(|((pid, s), sub)| {
                *pid == peer.peer_id
                    && sub.term == id
                    && stream.is_none_or(|want| want == u64::from(*s))
            })
            .map(|(k, _)| k.clone())
            .collect();
        keys.iter().filter_map(|k| subs.remove(k)).collect()
    };
    for s in gone {
        tap::unsubscribe(&s.term, s.wid);
    }
}

/// Drops the watchers `peer_id` had on links that are now closed.
pub(crate) fn link_closed(core: &Core, peer_id: &str) {
    let online = core.is_online(peer_id);
    let gone: Vec<Sub> = {
        let mut subs = lock(&core.side.subs);
        let keys: Vec<(String, u32)> = subs
            .iter()
            .filter(|((pid, _), sub)| pid == peer_id && (!online || !sub.link.is_open()))
            .map(|(k, _)| k.clone())
            .collect();
        keys.iter().filter_map(|k| subs.remove(k)).collect()
    };
    for s in gone {
        tap::unsubscribe(&s.term, s.wid);
    }
}

/// A lower role takes effect on what `peer_id` already watches.
pub(crate) fn role_changed(core: &Core, peer_id: &str, role: PeerRole) {
    if !role.allows(PeerRole::Viewer) {
        let gone: Vec<Sub> = {
            let mut subs = lock(&core.side.subs);
            let keys: Vec<(String, u32)> = subs
                .keys()
                .filter(|(pid, _)| pid == peer_id)
                .cloned()
                .collect();
            keys.iter().filter_map(|k| subs.remove(k)).collect()
        };
        for s in gone {
            tap::unsubscribe(&s.term, s.wid);
        }
    }
    if !role.allows(PeerRole::Operator) {
        lock(&core.side.allowed).retain(|(pid, _), _| pid != peer_id);
    }
}

/// Ends every remote watcher and waiting question.
pub(crate) fn forget_all(core: &Core) {
    let subs: Vec<Sub> = lock(&core.side.subs).drain().map(|(_, s)| s).collect();
    for s in subs {
        tap::unsubscribe(&s.term, s.wid);
    }
    lock(&core.side.confirms).clear();
    lock(&core.side.allowed).clear();
}
