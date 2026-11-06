//! Paired computers (`peer/1`): the listener, pairing, the links to each
//! paired computer and the calls made over them.
//!
//! `Core` holds no Tauri types, so tests run two of them over in-memory
//! pipes. `cmd` is the Tauri glue: managed state, commands and events.
//! `host` answers what a paired computer asks of this one; `tap` copies PTY
//! output for watchers; `mail` routes a hand-off to another computer.
//!
//! Nothing here logs pairing codes, keys, SAS, terminal bytes or hand-off
//! bodies.

pub(crate) mod cmd;
pub(crate) mod host;
pub(crate) mod mail;
pub(crate) mod tap;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError, RwLock, Weak};
use std::time::Duration;

use serde_json::{Value, json};
use xdev_link::server::Window;
use xdev_link::{
    Backoff, Clock, Connect, Dialer, Discover, Host, HostKey, JoinTarget, Link, LinkError,
    LinkEvent, NoRelay, PairCode, PairOfferView, PairPending, PairTarget, PairWindow, PeerCtx,
    PeerPairRequest, PeerPairResult, PeerRole, PeerStore, PeerTermAttached, PeerTermClosed,
    PeerView, PendingPair, RpcError, Serve,
};

pub(crate) use host::{HostEnv, LocalProject};

/// The protocol a `hello` names.
pub(crate) const PROTO: &str = "peer/1";
/// How long a plain call waits for its answer.
pub(crate) const CALL_WAIT: Duration = Duration::from_secs(15);
/// An action the other computer may hold for a click (`confirm_each`, 60 s).
pub(crate) const ACTION_WAIT: Duration = Duration::from_secs(75);
/// A dialed link with no watch on it closes this long after its last use.
pub(crate) const IDLE_MS: u64 = 120_000;
/// The header of each stream frame: the big-endian seq of its first byte.
pub(crate) const SEQ_LEN: usize = 8;

/// What a paired computer said about itself in its `hello`.
#[derive(Debug, Clone, Default)]
struct Hello {
    their_role: Option<PeerRole>,
    xid: Option<String>,
}

/// A pairing this computer joined, waiting for the SAS check here.
struct Join {
    pending: PendingPair,
    grant_back: bool,
}

/// Where a watched remote terminal's bytes go.
pub(crate) type Out = Box<dyn Fn(&[u8]) + Send + Sync>;

/// A remote terminal shown here: where its bytes go and how far they got.
pub(crate) struct Watch {
    peer_id: String,
    term_id: String,
    stream: AtomicU32,
    /// The seq just past the last byte delivered.
    seq: AtomicU64,
    alive: AtomicBool,
    out: Out,
}

impl Watch {
    /// Delivers what is new in a frame that starts at `seq`.
    fn deliver(&self, seq: u64, bytes: &[u8]) {
        let have = self.seq.load(Ordering::SeqCst);
        let end = seq + bytes.len() as u64;
        if end <= have {
            return;
        }
        let skip = have.saturating_sub(seq) as usize;
        (self.out)(&bytes[skip..]);
        self.seq.store(end, Ordering::SeqCst);
    }
}

pub(crate) struct Core {
    pub(crate) env: Arc<dyn HostEnv>,
    pub(crate) key: Arc<HostKey>,
    pub(crate) store: Arc<PeerStore>,
    pub(crate) discover: Arc<dyn Discover>,
    pub(crate) clock: Arc<dyn Clock>,
    dialer: Dialer,
    pub(crate) window: Window,
    host: Mutex<Option<Arc<Host>>>,
    dialed: Mutex<HashMap<String, Arc<Link>>>,
    used: Mutex<HashMap<String, u64>>,
    hellos: Mutex<HashMap<String, Hello>>,
    watches: Mutex<Vec<Arc<Watch>>>,
    joins: Mutex<HashMap<String, Join>>,
    next_stream: AtomicU32,
    stopped: AtomicBool,
    pub(crate) side: host::HostSide,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

pub(crate) fn rpc(e: &LinkError) -> RpcError {
    RpcError::code(match e {
        LinkError::Denied => "peer_denied",
        e => e.code(),
    })
}

/// The hashed xDev ID a `hello` carries: sha256 of the lowercased email.
pub(crate) fn xid_of(email: &str) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(email.trim().to_lowercase().as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Forwards link traffic to the core while it lives.
struct ServeCore(Weak<Core>);

impl Serve for ServeCore {
    fn call(&self, peer: &PeerCtx, m: &str, p: Value) -> Result<Value, RpcError> {
        let core = self.0.upgrade().ok_or_else(|| RpcError::code("closed"))?;
        host::call(&core, peer, m, p)
    }

    fn on_notify(&self, peer: &PeerCtx, m: &str, p: Value) {
        if let Some(core) = self.0.upgrade() {
            core.notified(peer, m, &p);
        }
    }

    fn on_stream(&self, peer: &PeerCtx, id: u32, bytes: &[u8]) {
        if let Some(core) = self.0.upgrade() {
            core.streamed(&peer.peer_id, id, bytes);
        }
    }

    fn on_close(&self, peer: &PeerCtx) {
        if let Some(core) = self.0.upgrade() {
            core.closed(&peer.peer_id);
        }
    }
}

impl Core {
    pub(crate) fn new(
        env: Arc<dyn HostEnv>,
        key: Arc<HostKey>,
        store: Arc<PeerStore>,
        discover: Arc<dyn Discover>,
        clock: Arc<dyn Clock>,
        connector: Box<dyn Connect>,
    ) -> Arc<Core> {
        Arc::new_cyclic(|weak: &Weak<Core>| {
            let name = env.host_name();
            let mut dialer = Dialer::new(
                key.clone(),
                &name,
                store.clone(),
                Arc::new(ServeCore(weak.clone())),
            );
            dialer.connector = connector;
            dialer.opts.clock = clock.clone();
            Core {
                env,
                key,
                store,
                discover,
                dialer,
                window: Arc::new(Mutex::new(None)),
                host: Mutex::new(None),
                dialed: Mutex::default(),
                used: Mutex::default(),
                hellos: Mutex::default(),
                watches: Mutex::default(),
                joins: Mutex::default(),
                next_stream: AtomicU32::new(1),
                stopped: AtomicBool::new(false),
                side: host::HostSide::new(clock.clone()),
                clock,
            }
        })
    }

    /// What the listener and `Host` answer calls with.
    pub(crate) fn serve(self: &Arc<Core>) -> Arc<dyn Serve> {
        Arc::new(ServeCore(Arc::downgrade(self)))
    }

    pub(crate) fn set_host(&self, host: Option<Arc<Host>>) {
        *lock(&self.host) = host;
    }

    pub(crate) fn host_id(&self) -> String {
        self.key.host_id()
    }

    fn now(&self) -> u64 {
        self.clock.now_ms()
    }

    /// Ends every link, watch and pending pairing.
    pub(crate) fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        for w in lock(&self.watches).drain(..) {
            w.alive.store(false, Ordering::SeqCst);
        }
        let dialed: Vec<_> = lock(&self.dialed).drain().map(|(_, l)| l).collect();
        for l in dialed {
            l.close();
        }
        if let Some(h) = lock(&self.host).take() {
            for l in h.links() {
                l.close();
            }
        }
        lock(&self.joins).clear();
        *lock(&self.window) = None;
        let _ = self.discover.set_pairing(None);
        host::forget_all(self);
    }

    // ---- links ----

    /// An open link to `peer_id`: the one it dialed here, else ours.
    pub(crate) fn open_link(&self, peer_id: &str) -> Option<Arc<Link>> {
        let accepted = lock(&self.host).as_ref().and_then(|h| h.link(peer_id));
        if let Some(l) = accepted.filter(|l| l.is_open()) {
            return Some(l);
        }
        lock(&self.dialed)
            .get(peer_id)
            .filter(|l| l.is_open())
            .cloned()
    }

    pub(crate) fn is_online(&self, peer_id: &str) -> bool {
        self.open_link(peer_id).is_some()
    }

    /// The open link to `peer_id`, dialing it when there is none.
    pub(crate) fn link_to(&self, peer_id: &str) -> Result<Arc<Link>, RpcError> {
        if self.stopped.load(Ordering::SeqCst) {
            return Err(RpcError::code("peer_offline"));
        }
        lock(&self.used).insert(peer_id.to_owned(), self.now());
        if let Some(l) = self.open_link(peer_id) {
            return Ok(l);
        }
        let peer = self
            .store
            .find_by_id(peer_id)
            .ok_or_else(|| RpcError::code("peer_offline"))?;
        let link = self
            .dialer
            .connect(&peer, self.discover.as_ref(), &NoRelay)
            .map_err(|e| rpc(&e))?;
        if let Some(old) = lock(&self.dialed).insert(peer_id.to_owned(), link.clone()) {
            old.close();
        }
        self.learn_hello(&link);
        self.env.changed();
        Ok(link)
    }

    /// Asks the other end who it is and what it lets this computer do.
    fn learn_hello(&self, link: &Link) {
        let me = self.hello_value(None);
        let Ok(v) = link.call("hello", me, CALL_WAIT) else {
            return;
        };
        let hello = Hello {
            their_role: v
                .get("yourRole")
                .and_then(|r| serde_json::from_value(r.clone()).ok()),
            xid: v.get("xid").and_then(Value::as_str).map(str::to_owned),
        };
        lock(&self.hellos).insert(link.peer().peer_id, hello);
    }

    /// This computer's `hello`, for `peer`'s role when it is known.
    pub(crate) fn hello_value(&self, role: Option<PeerRole>) -> Value {
        let mut v = json!({
            "proto": PROTO,
            "name": self.env.host_name(),
            "hostId": self.host_id(),
        });
        if let Some(role) = role {
            v["yourRole"] = json!(role);
        }
        if let Some(xid) = self.env.xid() {
            v["xid"] = json!(xid);
        }
        v
    }

    /// A call to `peer_id`, dialing when needed.
    pub(crate) fn call(
        &self,
        peer_id: &str,
        m: &str,
        p: Value,
        wait: Duration,
    ) -> Result<Value, RpcError> {
        let link = self.link_to(peer_id)?;
        let r = link.call(m, p, wait);
        lock(&self.used).insert(peer_id.to_owned(), self.now());
        r.map_err(|e| match e.code.as_str() {
            "closed" | "timeout" => RpcError::code("peer_offline"),
            _ => e,
        })
    }

    /// Closes dialed links nothing used for `IDLE_MS` and no watch holds.
    pub(crate) fn reap_idle(&self) {
        let now = self.now();
        let watched: Vec<String> = lock(&self.watches)
            .iter()
            .map(|w| w.peer_id.clone())
            .collect();
        let used = lock(&self.used).clone();
        let idle: Vec<Arc<Link>> = {
            let mut dialed = lock(&self.dialed);
            let ids: Vec<String> = dialed
                .keys()
                .filter(|id| !watched.contains(id))
                .filter(|id| now.saturating_sub(used.get(*id).copied().unwrap_or(0)) >= IDLE_MS)
                .cloned()
                .collect();
            ids.iter().filter_map(|id| dialed.remove(id)).collect()
        };
        for l in idle {
            l.close();
        }
    }

    // ---- events from the host and the links ----

    pub(crate) fn on_event(self: &Arc<Core>, ev: LinkEvent) {
        match ev {
            LinkEvent::PairRequest {
                request_id,
                name,
                kind,
                sas,
                ..
            } => self.env.emit(
                "peers://pair-request",
                json!(PeerPairRequest {
                    request_id,
                    name,
                    kind,
                    sas,
                }),
            ),
            LinkEvent::Paired { peer } => {
                let _ = self.discover.set_pairing(None);
                self.pair_result(Ok(peer.name));
            }
            LinkEvent::PairFailed { code, .. } => self.pair_result(Err(code.to_owned())),
            LinkEvent::Connected { link, .. } => {
                let me = self.clone();
                std::thread::spawn(move || {
                    me.learn_hello(&link);
                    me.env.changed();
                });
                self.env.changed();
            }
            LinkEvent::Disconnected { .. } => self.env.changed(),
        }
    }

    fn pair_result(&self, r: Result<String, String>) {
        let res = match r {
            Ok(name) => PeerPairResult {
                ok: true,
                name: Some(name),
                error: None,
            },
            Err(code) => PeerPairResult {
                ok: false,
                name: None,
                error: Some(code),
            },
        };
        self.env.emit("peers://pair-result", json!(res));
        self.env.changed();
    }

    fn closed(&self, peer_id: &str) {
        lock(&self.dialed).retain(|_, l| l.is_open());
        if !self.is_online(peer_id) {
            lock(&self.hellos).remove(peer_id);
        }
        host::link_closed(self, peer_id);
        if !self.stopped.load(Ordering::SeqCst) {
            self.env.changed();
        }
    }

    fn notified(&self, peer: &PeerCtx, m: &str, p: &Value) {
        if m != "term.closed" {
            return;
        }
        let stream = p.get("stream").and_then(Value::as_u64);
        let reason = p.get("reason").and_then(Value::as_str).unwrap_or("exited");
        let gone = {
            let mut w = lock(&self.watches);
            let i = w.iter().position(|w| {
                w.peer_id == peer.peer_id
                    && Some(u64::from(w.stream.load(Ordering::SeqCst))) == stream
            });
            i.map(|i| w.remove(i))
        };
        if let Some(w) = gone {
            w.alive.store(false, Ordering::SeqCst);
            self.term_closed(&w, reason);
        }
    }

    fn streamed(&self, peer_id: &str, id: u32, bytes: &[u8]) {
        if bytes.len() < SEQ_LEN {
            return;
        }
        let watch = lock(&self.watches)
            .iter()
            .find(|w| w.peer_id == peer_id && w.stream.load(Ordering::SeqCst) == id)
            .cloned();
        if let Some(w) = watch {
            let mut seq = [0u8; SEQ_LEN];
            seq.copy_from_slice(&bytes[..SEQ_LEN]);
            w.deliver(u64::from_be_bytes(seq), &bytes[SEQ_LEN..]);
        }
    }

    fn term_closed(&self, w: &Watch, reason: &str) {
        self.env.emit(
            "peers://term-closed",
            json!(PeerTermClosed {
                peer_id: w.peer_id.clone(),
                term_id: w.term_id.clone(),
                reason: reason.to_owned(),
            }),
        );
    }

    // ---- pairing ----

    /// Opens the pair window with a fresh code and announces it.
    pub(crate) fn pair_start(&self, candidates: Vec<String>) -> Result<PairOfferView, RpcError> {
        let name = self.env.host_name();
        let window = PairWindow::new(&name, self.now()).map_err(|e| rpc(&e))?;
        let offer = window.offer(self.key.public(), candidates.clone());
        let view = PairOfferView {
            code: window.code().display(),
            link: offer.to_uri(),
            expires_at_ms: window.expires_ms(),
            candidates,
        };
        *lock(&self.window) = Some(window);
        let _ = self.discover.set_pairing(Some(&name));
        self.env.changed();
        Ok(view)
    }

    pub(crate) fn pair_cancel(&self) {
        *lock(&self.window) = None;
        let _ = self.discover.set_pairing(None);
        self.env.changed();
    }

    pub(crate) fn pairing(&self) -> bool {
        let now = self.now();
        lock(&self.window).as_ref().is_some_and(|w| w.is_open(now))
    }

    /// Runs the handshake with the computer showing `code`; the SAS check
    /// and `pair_confirm` finish it.
    pub(crate) fn pair_join(
        &self,
        target: &JoinTarget,
        code: &str,
        grant_back: bool,
    ) -> Result<PairPending, RpcError> {
        let code = PairCode::parse(code).map_err(|_| RpcError::code("pair_code"))?;
        let target = PairTarget::from_join(target, self.discover.as_ref(), self.now()).map_err(
            |e| match e {
                LinkError::Offer(_) => RpcError::code("pair_code"),
                e => rpc(&e),
            },
        )?;
        let pending = self.dialer.pair(&target, &code).map_err(|e| rpc(&e))?;
        let request_id = uuid::Uuid::new_v4().simple().to_string();
        let view = PairPending {
            request_id: request_id.clone(),
            sas: pending.sas.clone(),
            name: pending.host_name.clone(),
        };
        lock(&self.joins).insert(
            request_id,
            Join {
                pending,
                grant_back,
            },
        );
        Ok(view)
    }

    /// Answers a pairing: the host's `PairRequest`, or the SAS check of one
    /// this computer joined. `role` is what the other computer gets here.
    pub(crate) fn pair_confirm(
        self: &Arc<Core>,
        request_id: &str,
        accept: bool,
        role: PeerRole,
    ) -> Result<(), RpcError> {
        let host = lock(&self.host).clone();
        if host.is_some_and(|h| h.confirm(request_id, accept, role)) {
            return Ok(());
        }
        let join = lock(&self.joins)
            .remove(request_id)
            .ok_or_else(|| RpcError::code("pair_rejected"))?;
        let me = self.clone();
        std::thread::spawn(move || me.finish_join(join, accept, role));
        Ok(())
    }

    fn finish_join(&self, join: Join, accept: bool, role: PeerRole) {
        let Join {
            pending,
            grant_back,
        } = join;
        let stored = pending.finish(accept).and_then(|peer| {
            let role = match (grant_back, role) {
                (false, _) => PeerRole::None,
                (true, PeerRole::None) => PeerRole::Viewer,
                (true, r) => r,
            };
            self.store.set_role(&peer.id, role)
        });
        match stored {
            Ok(peer) => self.pair_result(Ok(peer.name)),
            Err(e) => self.pair_result(Err(rpc(&e).code)),
        }
    }

    // ---- peers ----

    pub(crate) fn view(&self, p: &xdev_link::StoredPeer) -> PeerView {
        let hello = lock(&self.hellos).get(&p.id).cloned();
        let mine = self.env.xid();
        PeerView {
            id: p.id.clone(),
            name: p.name.clone(),
            kind: p.kind,
            role: p.role,
            their_role: hello.as_ref().and_then(|h| h.their_role),
            online: self.is_online(&p.id),
            last_seen_ms: p.last_seen_at,
            same_xdev_id: mine.is_some() && hello.and_then(|h| h.xid) == mine,
        }
    }

    pub(crate) fn list(&self) -> Vec<PeerView> {
        self.store.list().iter().map(|p| self.view(p)).collect()
    }

    fn found(&self, peer_id: &str) -> Result<xdev_link::StoredPeer, RpcError> {
        self.store
            .find_by_id(peer_id)
            .ok_or_else(|| RpcError::code("peer_offline"))
    }

    pub(crate) fn set_role(&self, peer_id: &str, role: PeerRole) -> Result<PeerView, RpcError> {
        self.found(peer_id)?;
        let peer = self.store.set_role(peer_id, role).map_err(|e| rpc(&e))?;
        if let Some(l) = lock(&self.host).as_ref().and_then(|h| h.link(peer_id)) {
            l.set_role(role);
        }
        if let Some(l) = lock(&self.dialed).get(peer_id) {
            l.set_role(role);
        }
        host::role_changed(self, peer_id, role);
        self.env.changed();
        Ok(self.view(&peer))
    }

    pub(crate) fn rename(&self, peer_id: &str, name: &str) -> Result<PeerView, RpcError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(RpcError::code("bad_request"));
        }
        self.found(peer_id)?;
        let peer = self.store.rename(peer_id, name).map_err(|e| rpc(&e))?;
        self.env.changed();
        Ok(self.view(&peer))
    }

    /// Forgets `peer_id` for good and drops its links at once.
    pub(crate) fn remove(&self, peer_id: &str) -> Result<(), RpcError> {
        self.store.remove(peer_id).map_err(|e| rpc(&e))?;
        if let Some(h) = lock(&self.host).as_ref() {
            h.drop_peer(peer_id);
        }
        if let Some(l) = lock(&self.dialed).remove(peer_id) {
            l.close();
        }
        lock(&self.hellos).remove(peer_id);
        lock(&self.watches).retain(|w| {
            let keep = w.peer_id != peer_id;
            if !keep {
                w.alive.store(false, Ordering::SeqCst);
            }
            keep
        });
        host::link_closed(self, peer_id);
        self.env.changed();
        Ok(())
    }

    /// Online peers whose name or id is `name` (any case).
    pub(crate) fn resolve(&self, name: &str) -> Option<String> {
        let name = name.trim();
        let peers = self.store.list();
        peers
            .iter()
            .find(|p| p.id == name)
            .or_else(|| peers.iter().find(|p| p.name.eq_ignore_ascii_case(name)))
            .map(|p| p.id.clone())
    }

    // ---- watching a remote terminal ----

    /// Streams `term_id` on `peer_id` to `out` until detached or closed, and
    /// re-attaches from the last seq after a drop.
    pub(crate) fn attach(
        self: &Arc<Core>,
        peer_id: &str,
        term_id: &str,
        out: Out,
    ) -> Result<PeerTermAttached, RpcError> {
        self.detach_quiet(peer_id, term_id);
        let w = Arc::new(Watch {
            peer_id: peer_id.to_owned(),
            term_id: term_id.to_owned(),
            stream: AtomicU32::new(0),
            seq: AtomicU64::new(0),
            alive: AtomicBool::new(true),
            out,
        });
        lock(&self.watches).push(w.clone());
        match self.attach_once(&w) {
            Ok((link, size)) => {
                let me = self.clone();
                std::thread::spawn(move || me.keep_watching(&w, link));
                Ok(size)
            }
            Err(e) => {
                lock(&self.watches).retain(|x| !Arc::ptr_eq(x, &w));
                Err(e)
            }
        }
    }

    fn attach_once(&self, w: &Watch) -> Result<(Arc<Link>, PeerTermAttached), RpcError> {
        let link = self.link_to(&w.peer_id)?;
        let stream = self.next_stream.fetch_add(1, Ordering::SeqCst);
        w.stream.store(stream, Ordering::SeqCst);
        let r = link
            .call(
                "term.attach",
                json!({
                    "id": w.term_id,
                    "from_seq": w.seq.load(Ordering::SeqCst),
                    "stream": stream,
                }),
                CALL_WAIT,
            )
            .map_err(|e| match e.code.as_str() {
                "closed" | "timeout" => RpcError::code("peer_offline"),
                _ => e,
            })?;
        let num = |k: &str, d: u16| {
            r.get(k)
                .and_then(Value::as_u64)
                .and_then(|n| u16::try_from(n).ok())
                .unwrap_or(d)
        };
        Ok((
            link,
            PeerTermAttached {
                cols: num("cols", 80),
                rows: num("rows", 24),
            },
        ))
    }

    /// Waits for the link to drop, says so, then re-attaches with backoff.
    fn keep_watching(&self, w: &Arc<Watch>, mut link: Arc<Link>) {
        let alive = || w.alive.load(Ordering::SeqCst) && !self.stopped.load(Ordering::SeqCst);
        loop {
            while alive() && !link.wait_timeout(Duration::from_millis(200)) {}
            if !alive() {
                return;
            }
            self.term_closed(w, "offline");
            let mut backoff = Backoff::new();
            loop {
                let until = std::time::Instant::now() + backoff.next_delay();
                while alive() && std::time::Instant::now() < until {
                    std::thread::sleep(Duration::from_millis(50));
                }
                if !alive() {
                    return;
                }
                match self.attach_once(w) {
                    Ok((l, _)) => {
                        link = l;
                        break;
                    }
                    Err(e) if e.code == "no_term" => {
                        lock(&self.watches).retain(|x| !Arc::ptr_eq(x, w));
                        self.term_closed(w, "exited");
                        return;
                    }
                    Err(_) => {}
                }
            }
        }
    }

    fn detach_quiet(&self, peer_id: &str, term_id: &str) -> Vec<Arc<Watch>> {
        let mut gone = Vec::new();
        lock(&self.watches).retain(|w| {
            let keep = !(w.peer_id == peer_id && w.term_id == term_id);
            if !keep {
                w.alive.store(false, Ordering::SeqCst);
                gone.push(w.clone());
            }
            keep
        });
        gone
    }

    pub(crate) fn detach(&self, peer_id: &str, term_id: &str) {
        let gone = self.detach_quiet(peer_id, term_id);
        if let Some(link) = self.open_link(peer_id) {
            for w in gone {
                let _ = link.call(
                    "term.detach",
                    json!({ "id": term_id, "stream": w.stream.load(Ordering::SeqCst) }),
                    CALL_WAIT,
                );
            }
        }
        lock(&self.used).insert(peer_id.to_owned(), self.now());
    }
}

/// The core while the link is on; `None` while it is off.
static CURRENT: RwLock<Option<Arc<Core>>> = RwLock::new(None);

pub(crate) fn current() -> Option<Arc<Core>> {
    CURRENT
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
}

pub(crate) fn set_current(core: Option<Arc<Core>>) {
    *CURRENT.write().unwrap_or_else(PoisonError::into_inner) = core;
}

/// The `peers` verb: each paired computer, whether it is online, what it
/// lets this computer do and, when that is at least Viewer, its tabs.
pub(crate) fn report() -> Vec<Value> {
    current().map(|c| c.report()).unwrap_or_default()
}

impl Core {
    pub(crate) fn report(&self) -> Vec<Value> {
        self.list()
            .into_iter()
            .map(|p| {
                let mut v = json!({
                    "name": p.name,
                    "online": p.online,
                    "theirRole": p.their_role,
                });
                let viewer = p.online && p.their_role.is_some_and(|r| r >= PeerRole::Viewer);
                if viewer {
                    let tabs = self
                        .call(&p.id, "terms.list", json!({}), CALL_WAIT)
                        .ok()
                        .and_then(|t| serde_json::from_value::<Vec<xdev_link::PeerTerm>>(t).ok())
                        .unwrap_or_default();
                    v["tabs"] = json!(
                        tabs.iter()
                            .map(|t| json!({ "id": t.id, "title": t.title, "state": t.state }))
                            .collect::<Vec<_>>()
                    );
                }
                v
            })
            .collect()
    }
}

/// The paired computer `name` stands for, by id or name, while the link is on.
pub(crate) fn resolve(name: &str) -> Option<String> {
    current()?.resolve(name)
}

#[cfg(test)]
pub(crate) mod tests;
