//! The host side: a WebSocket listener, the pairing confirmation and the
//! IK check for known peers.
//!
//! Each connection gets a thread. The WebSocket upgrade and the Noise
//! handshake each have 10 s; the first message picks the pattern (see
//! `proto`). An IK dialer whose key is not in the store is refused before
//! any app data. A pairing waits up to 120 s for `Handle::confirm`.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream};
use std::ops::RangeInclusive;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::error::LinkError;
use crate::identity::HostKey;
use crate::link::{Link, LinkOpts, PeerCtx, Serve};
use crate::noise::{self, Session};
use crate::offer::PairWindow;
use crate::peers::{PeerStore, StoredPeer};
use crate::proto::{self, TAG_IK, TAG_PAIR_CODE, TAG_PAIR_SECRET};
use crate::types::{LinkBind, PeerKind, PeerRole};
use crate::wire::{POLL, Wire, WsWire, recv_until};

pub const PORTS: RangeInclusive<u16> = 47821..=47836;
pub const HANDSHAKE_MS: u64 = 10_000;
pub const CONFIRM_MS: u64 = 120_000;

#[derive(Debug, Clone)]
pub struct ListenCfg {
    pub bind: LinkBind,
    pub port_range: RangeInclusive<u16>,
    pub max_phone: usize,
    pub max_desktop: usize,
}

impl Default for ListenCfg {
    fn default() -> Self {
        ListenCfg {
            bind: LinkBind::Lan,
            port_range: PORTS,
            max_phone: 4,
            max_desktop: 4,
        }
    }
}

#[derive(Debug)]
pub enum LinkEvent {
    /// Show the SAS and ask; answer with `Handle::confirm`.
    PairRequest {
        request_id: String,
        name: String,
        kind: PeerKind,
        sas: String,
        remote_pub: [u8; 32],
    },
    Paired {
        peer: StoredPeer,
    },
    PairFailed {
        request_id: Option<String>,
        code: &'static str,
    },
    Connected {
        peer_id: String,
        link: Arc<Link>,
    },
    Disconnected {
        peer_id: String,
    },
}

pub type Window = Arc<Mutex<Option<PairWindow>>>;

/// Timing knobs; tests shorten them.
#[derive(Clone)]
pub struct HostOpts {
    pub link: LinkOpts,
    pub handshake_ms: u64,
    pub confirm_ms: u64,
}

impl Default for HostOpts {
    fn default() -> Self {
        HostOpts {
            link: LinkOpts::default(),
            handshake_ms: HANDSHAKE_MS,
            confirm_ms: CONFIRM_MS,
        }
    }
}

/// Everything a connection needs, shared by all of them.
pub struct Host {
    key: Arc<HostKey>,
    store: Arc<PeerStore>,
    window: Window,
    serve: Arc<dyn Serve>,
    events: Mutex<Sender<LinkEvent>>,
    confirms: Mutex<HashMap<String, Sender<(bool, PeerRole)>>>,
    links: Mutex<HashMap<String, Arc<Link>>>,
    phones: AtomicUsize,
    desktops: AtomicUsize,
    max_phone: usize,
    max_desktop: usize,
    opts: HostOpts,
}

impl Host {
    pub fn new(
        key: Arc<HostKey>,
        store: Arc<PeerStore>,
        window: Window,
        serve: Arc<dyn Serve>,
        events: Sender<LinkEvent>,
        cfg: &ListenCfg,
        opts: HostOpts,
    ) -> Arc<Host> {
        Arc::new(Host {
            key,
            store,
            window,
            serve,
            events: Mutex::new(events),
            confirms: Mutex::default(),
            links: Mutex::default(),
            phones: AtomicUsize::new(0),
            desktops: AtomicUsize::new(0),
            max_phone: cfg.max_phone,
            max_desktop: cfg.max_desktop,
            opts,
        })
    }

    fn emit(&self, ev: LinkEvent) {
        if let Ok(tx) = self.events.lock() {
            let _ = tx.send(ev);
        }
    }

    fn now(&self) -> u64 {
        self.opts.link.clock.now_ms()
    }

    /// Answers a `PairRequest`. `false` when it is no longer waiting.
    pub fn confirm(&self, request_id: &str, accept: bool, role: PeerRole) -> bool {
        let tx = self
            .confirms
            .lock()
            .ok()
            .and_then(|mut c| c.remove(request_id));
        tx.is_some_and(|tx| tx.send((accept, role)).is_ok())
    }

    pub fn link(&self, peer_id: &str) -> Option<Arc<Link>> {
        self.links.lock().ok()?.get(peer_id).cloned()
    }

    pub fn links(&self) -> Vec<Arc<Link>> {
        self.links
            .lock()
            .map(|l| l.values().cloned().collect())
            .unwrap_or_default()
    }

    /// Closes the link to `peer_id`, if any (after a remove or a role cut).
    pub fn drop_peer(&self, peer_id: &str) {
        if let Some(link) = self.links.lock().ok().and_then(|mut l| l.remove(peer_id)) {
            link.close();
        }
    }

    fn close_all(&self) {
        let all: Vec<Arc<Link>> = self
            .links
            .lock()
            .map(|mut l| l.drain().map(|(_, v)| v).collect())
            .unwrap_or_default();
        for l in all {
            l.close();
        }
    }

    fn counter(&self, kind: PeerKind) -> (&AtomicUsize, usize) {
        match kind {
            PeerKind::Phone => (&self.phones, self.max_phone),
            PeerKind::Desktop => (&self.desktops, self.max_desktop),
        }
    }
}

/// Undoes `PairWindow::begin` unless the pairing completed.
struct Busy<'a> {
    window: &'a Window,
    armed: bool,
}

impl Busy<'_> {
    fn fail(mut self) {
        if let Ok(mut w) = self.window.lock()
            && let Some(w) = w.as_mut()
        {
            w.fail();
        }
        self.armed = false;
    }
}

impl Drop for Busy<'_> {
    fn drop(&mut self) {
        if self.armed
            && let Ok(mut w) = self.window.lock()
            && let Some(w) = w.as_mut()
        {
            w.end();
        }
    }
}

/// Serves one accepted connection to its end.
pub fn serve_conn(mut wire: Box<dyn Wire>, host: &Arc<Host>) {
    let deadline = Instant::now() + Duration::from_millis(host.opts.handshake_ms);
    let Ok(first) = recv_until(wire.as_mut(), deadline) else {
        wire.close();
        return;
    };
    let Some((&tag, msg1)) = first.split_first() else {
        wire.close();
        return;
    };
    match tag {
        TAG_PAIR_CODE | TAG_PAIR_SECRET => pair(wire, host, tag, msg1, deadline),
        TAG_IK => ik(wire, host, msg1, deadline),
        _ => wire.close(),
    }
}

fn request_id() -> String {
    let mut b = [0u8; 8];
    let _ = getrandom::fill(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn pair(mut wire: Box<dyn Wire>, host: &Arc<Host>, tag: u8, msg1: &[u8], deadline: Instant) {
    let w = wire.as_mut();
    let (psk, host_name) = {
        let Ok(mut guard) = host.window.lock() else {
            return proto::reject(w, &LinkError::PairBusy);
        };
        let now = host.now();
        let Some(win) = guard.as_mut().filter(|win| win.is_open(now)) else {
            return proto::reject(w, &LinkError::PairCode);
        };
        if !win.begin(now) {
            return proto::reject(w, &LinkError::PairBusy);
        }
        let psk = if tag == TAG_PAIR_CODE {
            win.code_psk()
        } else {
            win.secret_psk()
        };
        (psk, win.name.clone())
    };
    let busy = Busy {
        window: &host.window,
        armed: true,
    };

    let hs = (|| {
        let mut hs = noise::xx_psk_responder(&host.key, &psk)?;
        hs.read(msg1)?;
        let msg2 = hs.write(&serde_json::to_vec(&json!({ "n": host_name })).unwrap_or_default())?;
        proto::send_ok(w, &msg2)?;
        Ok::<_, LinkError>(hs)
    })();
    let Ok(mut hs) = hs else {
        return w.close();
    };
    let Ok(msg3) = proto::recv_step(w, deadline) else {
        return w.close();
    };
    // A wrong psk shows here, at the third message.
    let Ok(hello) = hs.read(&msg3) else {
        busy.fail();
        host.emit(LinkEvent::PairFailed {
            request_id: None,
            code: LinkError::PairCode.code(),
        });
        return proto::reject(w, &LinkError::PairCode);
    };
    let Ok(mut session) = hs.finish() else {
        return w.close();
    };
    let hello: Value = serde_json::from_slice(&hello).unwrap_or(Value::Null);
    let name: String = hello
        .get("n")
        .and_then(Value::as_str)
        .unwrap_or("")
        .chars()
        .take(crate::offer::NAME_MAX)
        .collect();
    let kind = match (tag, hello.get("k").and_then(Value::as_str)) {
        (TAG_PAIR_CODE, Some("phone")) | (TAG_PAIR_SECRET, _) => PeerKind::Phone,
        _ => PeerKind::Desktop,
    };
    if proto::send_sealed(w, &mut session, proto::M_READY, Value::Null).is_err() {
        return w.close();
    }

    let id = request_id();
    let (tx, rx) = std::sync::mpsc::channel();
    if let Ok(mut c) = host.confirms.lock() {
        c.insert(id.clone(), tx);
    }
    host.emit(LinkEvent::PairRequest {
        request_id: id.clone(),
        name: name.clone(),
        kind,
        sas: noise::sas(&session.hash),
        remote_pub: session.remote_pub,
    });
    let outcome = await_both(w, &mut session, &rx, host.opts.confirm_ms);
    if let Ok(mut c) = host.confirms.lock() {
        c.remove(&id);
    }
    let result = outcome.and_then(|role| {
        let consumed = host
            .window
            .lock()
            .ok()
            .and_then(|mut g| g.as_mut().map(|win| win.try_consume(host.now())))
            .unwrap_or(false);
        if !consumed {
            return Err(LinkError::PairCode);
        }
        let mut peer = StoredPeer::new(&name, kind, &session.remote_pub, host.now());
        peer.role = role;
        host.store.add(peer)
    });
    let accept = result.is_ok();
    let _ = proto::send_sealed(
        w,
        &mut session,
        proto::M_RESULT,
        json!({ "accept": accept }),
    );
    if !accept {
        drain(w);
    }
    w.close();
    drop(busy);
    match result {
        Ok(peer) => host.emit(LinkEvent::Paired { peer }),
        Err(e) => host.emit(LinkEvent::PairFailed {
            request_id: Some(id),
            code: e.code(),
        }),
    }
}

/// After a refusal, waits briefly for the joiner's own answer or its hang-up.
/// Closing with that answer still unread makes the OS reset the connection,
/// and the reset can drop the refusal before the joiner reads it.
fn drain(w: &mut dyn Wire) {
    let deadline = Instant::now() + DRAIN;
    while Instant::now() < deadline {
        match w.poll() {
            Ok(None) => {}
            Ok(Some(_)) | Err(_) => return,
        }
    }
}

const DRAIN: Duration = Duration::from_secs(2);

/// Waits for this side's answer and the joiner's, whichever comes first.
/// `Ok(role)` when both said yes.
fn await_both(
    w: &mut dyn Wire,
    session: &mut Session,
    local: &Receiver<(bool, PeerRole)>,
    confirm_ms: u64,
) -> Result<PeerRole, LinkError> {
    let deadline = Instant::now() + Duration::from_millis(confirm_ms);
    let mut mine: Option<PeerRole> = None;
    let mut theirs = false;
    loop {
        if mine.is_none() {
            match local.try_recv() {
                Ok((true, role)) => mine = Some(role),
                Ok((false, _)) => return Err(LinkError::PairRejected),
                Err(_) => {}
            }
        }
        if !theirs {
            match w.poll() {
                Ok(Some(msg)) => {
                    let (m, p) = proto::split(&msg).and_then(|b| proto::open_sealed(session, b))?;
                    if m != proto::M_CONFIRM || p.get("accept") != Some(&Value::Bool(true)) {
                        return Err(LinkError::PairRejected);
                    }
                    theirs = true;
                }
                Ok(None) => {}
                Err(_) => return Err(LinkError::PairRejected),
            }
        } else {
            std::thread::sleep(POLL);
        }
        if let (Some(role), true) = (mine, theirs) {
            return Ok(role);
        }
        if Instant::now() >= deadline {
            return Err(LinkError::Timeout);
        }
    }
}

fn ik(mut wire: Box<dyn Wire>, host: &Arc<Host>, msg1: &[u8], deadline: Instant) {
    let w = wire.as_mut();
    let Ok(mut hs) = noise::ik_responder(&host.key) else {
        return w.close();
    };
    if hs.read(msg1).is_err() {
        return w.close();
    }
    let Some(peer) = hs.remote_static().and_then(|k| host.store.find_by_pub(&k)) else {
        // Unknown key: refused before any app data, and before msg2.
        return proto::reject(w, &LinkError::Denied);
    };
    if Instant::now() >= deadline {
        return w.close();
    }
    let (count, max) = host.counter(peer.kind);
    if count.fetch_add(1, Ordering::SeqCst) >= max {
        count.fetch_sub(1, Ordering::SeqCst);
        return proto::reject(w, &LinkError::PairBusy);
    }
    let session = (|| {
        let msg2 = hs.write(&[])?;
        proto::send_ok(w, &msg2)?;
        hs.finish()
    })();
    let (Ok(session), Some(ctx)) = (session, PeerCtx::from_peer(&peer)) else {
        count.fetch_sub(1, Ordering::SeqCst);
        return w.close();
    };
    let _ = host
        .store
        .touch(&peer.id, wire.peer_addr().as_deref(), host.now());
    let link = Arc::new(Link::start(
        wire,
        session,
        ctx,
        host.serve.clone(),
        host.opts.link.clone(),
    ));
    let old = host
        .links
        .lock()
        .ok()
        .and_then(|mut l| l.insert(peer.id.clone(), link.clone()));
    if let Some(old) = old {
        old.close();
    }
    host.emit(LinkEvent::Connected {
        peer_id: peer.id.clone(),
        link: link.clone(),
    });
    link.wait();
    count.fetch_sub(1, Ordering::SeqCst);
    if let Ok(mut l) = host.links.lock()
        && l.get(&peer.id).is_some_and(|cur| Arc::ptr_eq(cur, &link))
    {
        l.remove(&peer.id);
    }
    host.emit(LinkEvent::Disconnected { peer_id: peer.id });
}

/// A running listener. Dropping it stops it.
pub struct Handle {
    host: Arc<Host>,
    port: u16,
    stop: Arc<AtomicBool>,
}

impl std::fmt::Debug for Handle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Handle").field("port", &self.port).finish()
    }
}

impl Handle {
    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn host(&self) -> &Arc<Host> {
        &self.host
    }

    pub fn confirm(&self, request_id: &str, accept: bool, role: PeerRole) -> bool {
        self.host.confirm(request_id, accept, role)
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        self.host.close_all();
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        self.stop();
    }
}

pub struct Listener;

impl Listener {
    /// Binds the first free port in `cfg.port_range` and accepts until the
    /// handle stops. `link_port` when none is free.
    pub fn start(
        cfg: ListenCfg,
        key: Arc<HostKey>,
        store: Arc<PeerStore>,
        window: Window,
        serve: Arc<dyn Serve>,
        events: Sender<LinkEvent>,
    ) -> Result<Handle, LinkError> {
        Listener::start_with(cfg, key, store, window, serve, events, HostOpts::default())
    }

    pub fn start_with(
        cfg: ListenCfg,
        key: Arc<HostKey>,
        store: Arc<PeerStore>,
        window: Window,
        serve: Arc<dyn Serve>,
        events: Sender<LinkEvent>,
        opts: HostOpts,
    ) -> Result<Handle, LinkError> {
        let ip: IpAddr = crate::net::bind_ip(cfg.bind).ok_or(LinkError::Port)?;
        let (listener, port) = cfg
            .port_range
            .clone()
            .find_map(|p| {
                TcpListener::bind(SocketAddr::new(ip, p))
                    .ok()
                    .map(|l| (l, p))
            })
            .ok_or(LinkError::Port)?;
        listener.set_nonblocking(true)?;
        let host = Host::new(key, store, window, serve, events, &cfg, opts);
        let stop = Arc::new(AtomicBool::new(false));
        {
            let host = host.clone();
            let stop = stop.clone();
            std::thread::Builder::new()
                .name("xdev-link-accept".into())
                .spawn(move || accept_loop(listener, host, stop))?;
        }
        Ok(Handle { host, port, stop })
    }
}

fn accept_loop(listener: TcpListener, host: Arc<Host>, stop: Arc<AtomicBool>) {
    while !stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((tcp, addr)) => {
                let host = host.clone();
                let _ = std::thread::Builder::new()
                    .name("xdev-link-conn".into())
                    .spawn(move || {
                        if let Some(wire) = upgrade(tcp, addr, host.opts.handshake_ms) {
                            serve_conn(wire, &host);
                        }
                    });
            }
            Err(_) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

/// The WebSocket upgrade, within the handshake time.
fn upgrade(tcp: TcpStream, addr: SocketAddr, handshake_ms: u64) -> Option<Box<dyn Wire>> {
    let t = Some(Duration::from_millis(handshake_ms));
    tcp.set_nonblocking(false).ok()?;
    tcp.set_read_timeout(t).ok()?;
    tcp.set_write_timeout(t).ok()?;
    let _ = tcp.set_nodelay(true);
    let ws = tungstenite::accept(tcp).ok()?;
    ws.get_ref().set_read_timeout(Some(POLL)).ok()?;
    Some(Box::new(WsWire::new(ws, Some(addr.to_string()))))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::FakeClock;
    use crate::dial::{Dialer, NoRelay, PairTarget};
    use crate::discovery::FakeDiscover;
    use crate::link::tests::Echo;
    use crate::mem::{MemConnect, pipe};
    use crate::offer::{PairCode, WINDOW_MAX_FAILURES};
    use std::sync::mpsc::channel;

    const T: Duration = Duration::from_secs(5);

    struct World {
        _dir: tempfile::TempDir,
        host: Arc<Host>,
        host_key: Arc<HostKey>,
        host_store: Arc<PeerStore>,
        events: Receiver<LinkEvent>,
        window: Window,
        dialer: Dialer,
        joiner_store: Arc<PeerStore>,
        connector: Arc<MemConnect>,
    }

    struct Shared(Arc<MemConnect>);
    impl crate::dial::Connect for Shared {
        fn connect(&self, addr: &str) -> Result<Box<dyn Wire>, LinkError> {
            self.0.connect(addr)
        }
    }

    fn world(joiner_key: u8) -> World {
        let dir = tempfile::tempdir().unwrap();
        let host_store = Arc::new(PeerStore::open(&dir.path().join("host.json")).unwrap());
        let joiner_store = Arc::new(PeerStore::open(&dir.path().join("joiner.json")).unwrap());
        let host_key = Arc::new(HostKey::from_private([10; 32]).unwrap());
        let clock = FakeClock::new(1_000);
        let window: Window = Arc::new(Mutex::new(Some(PairWindow::with(
            "this-pc",
            PairCode::parse("7K4QM-2XD9P").unwrap(),
            [9; 32],
            1_000,
        ))));
        let (tx, events) = channel();
        let opts = HostOpts {
            link: LinkOpts {
                clock: Arc::new(clock),
                ..LinkOpts::default()
            },
            handshake_ms: 5_000,
            confirm_ms: 5_000,
        };
        let host = Host::new(
            host_key.clone(),
            host_store.clone(),
            window.clone(),
            Arc::new(Echo::default()),
            tx,
            &ListenCfg::default(),
            opts,
        );
        let connector = Arc::new(MemConnect::default());
        let mut dialer = Dialer::new(
            Arc::new(HostKey::from_private([joiner_key; 32]).unwrap()),
            "studio-mac",
            joiner_store.clone(),
            Arc::new(Echo::default()),
        );
        dialer.connector = Box::new(Shared(connector.clone()));
        dialer.confirm_timeout = T;
        dialer.handshake_timeout = T;
        World {
            _dir: dir,
            host,
            host_key,
            host_store,
            events,
            window,
            dialer,
            joiner_store,
            connector,
        }
    }

    /// Plugs a fresh pipe into the host at `addr`.
    fn plug(w: &World, addr: &str) -> std::thread::JoinHandle<()> {
        let (a, b) = pipe();
        w.connector.add(addr, a);
        let host = w.host.clone();
        std::thread::spawn(move || serve_conn(Box::new(b), &host))
    }

    fn target() -> PairTarget {
        PairTarget {
            addrs: vec!["mem".into()],
            host_pub: None,
        }
    }

    fn code(s: &str) -> PairCode {
        PairCode::parse(s).unwrap()
    }

    fn next(w: &World) -> LinkEvent {
        w.events.recv_timeout(T).expect("an event")
    }

    #[test]
    fn pair_then_reconnect_over_ik() {
        let w = world(20);
        let conn = plug(&w, "mem");
        let pending = w.dialer.pair(&target(), &code("7k4qm 2xd9p")).unwrap();
        assert_eq!(pending.host_name, "this-pc");
        assert_eq!(pending.host_pub, w.host_key.public());
        let LinkEvent::PairRequest {
            request_id,
            name,
            kind,
            sas,
            ..
        } = next(&w)
        else {
            panic!("expected a pair request");
        };
        assert_eq!(name, "studio-mac");
        assert_eq!(kind, PeerKind::Desktop);
        assert_eq!(sas, pending.sas, "both screens show the same SAS");
        assert_eq!(sas.len(), 7);

        let joiner = std::thread::spawn(move || pending.finish(true));
        assert!(w.host.confirm(&request_id, true, PeerRole::Viewer));
        let host_peer = joiner.join().unwrap().unwrap();
        assert_eq!(host_peer.role, PeerRole::None);
        assert_eq!(host_peer.public(), Some(w.host_key.public()));
        let LinkEvent::Paired { peer } = next(&w) else {
            panic!("expected paired");
        };
        assert_eq!(peer.role, PeerRole::Viewer);
        assert_eq!(peer.name, "studio-mac");
        assert_eq!(w.host_store.list().len(), 1);
        assert_eq!(w.joiner_store.list().len(), 1);
        conn.join().unwrap();
        // Single use.
        assert!(!w.window.lock().unwrap().as_ref().unwrap().is_open(1_000));

        let mut host_peer = host_peer;
        host_peer.addrs = vec!["mem2".into()];
        let _conn = plug(&w, "mem2");
        let link = w
            .dialer
            .connect(&host_peer, &FakeDiscover::default(), &NoRelay)
            .unwrap();
        let LinkEvent::Connected {
            peer_id,
            link: host_link,
        } = next(&w)
        else {
            panic!("expected connected");
        };
        assert_eq!(peer_id, peer.id);
        assert_eq!(
            link.call("echo", json!({"a": 1}), T).unwrap(),
            json!({"a": 1})
        );
        // Viewer here: the host's Serve refuses Operator calls.
        assert_eq!(
            link.call("write", Value::Null, T).unwrap_err().code,
            "peer_role"
        );
        assert_eq!(host_link.peer().role, PeerRole::Viewer);
        link.close();
        assert!(matches!(next(&w), LinkEvent::Disconnected { .. }));
        assert!(w.host.link(&peer.id).is_none());
    }

    #[test]
    fn wrong_code_fails_before_sas_and_counts() {
        let w = world(21);
        for i in 0..WINDOW_MAX_FAILURES {
            let conn = plug(&w, "mem");
            let e = w.dialer.pair(&target(), &code("00000-00000")).unwrap_err();
            assert_eq!(e, LinkError::PairCode, "attempt {i}");
            conn.join().unwrap();
            assert!(matches!(
                next(&w),
                LinkEvent::PairFailed {
                    code: "pair_code",
                    ..
                }
            ));
        }
        // Five failures close the window: the right code fails too.
        let conn = plug(&w, "mem");
        let e = w.dialer.pair(&target(), &code("7K4QM-2XD9P")).unwrap_err();
        assert_eq!(e, LinkError::PairCode);
        conn.join().unwrap();
        assert!(w.host_store.list().is_empty());
    }

    #[test]
    fn busy_and_rejected() {
        let w = world(22);
        w.window.lock().unwrap().as_mut().unwrap().begin(1_000);
        let conn = plug(&w, "mem");
        assert_eq!(
            w.dialer.pair(&target(), &code("7K4QM-2XD9P")).unwrap_err(),
            LinkError::PairBusy
        );
        conn.join().unwrap();
        w.window.lock().unwrap().as_mut().unwrap().end();

        let conn = plug(&w, "mem");
        let pending = w.dialer.pair(&target(), &code("7K4QM-2XD9P")).unwrap();
        let LinkEvent::PairRequest { request_id, .. } = next(&w) else {
            panic!("expected a pair request");
        };
        let joiner = std::thread::spawn(move || pending.finish(true));
        assert!(w.host.confirm(&request_id, false, PeerRole::Operator));
        assert_eq!(joiner.join().unwrap().unwrap_err(), LinkError::PairRejected);
        conn.join().unwrap();
        assert!(matches!(
            next(&w),
            LinkEvent::PairFailed {
                code: "pair_rejected",
                ..
            }
        ));
        assert!(w.host_store.list().is_empty());
        assert!(w.joiner_store.list().is_empty());
        // A refusal does not use the window up.
        assert!(w.window.lock().unwrap().as_ref().unwrap().is_open(1_000));
    }

    #[test]
    fn offer_secret_pairs_a_phone() {
        let w = world(23);
        let conn = plug(&w, "mem");
        let pending = w
            .dialer
            .pair_with(&target(), TAG_PAIR_SECRET, &[9; 32])
            .unwrap();
        let LinkEvent::PairRequest {
            request_id, kind, ..
        } = next(&w)
        else {
            panic!("expected a pair request");
        };
        assert_eq!(kind, PeerKind::Phone);
        let joiner = std::thread::spawn(move || pending.finish(true));
        assert!(w.host.confirm(&request_id, true, PeerRole::Operator));
        joiner.join().unwrap().unwrap();
        conn.join().unwrap();
    }

    #[test]
    fn wrong_host_key_in_offer_is_refused() {
        let w = world(24);
        let conn = plug(&w, "mem");
        let t = PairTarget {
            addrs: vec!["mem".into()],
            host_pub: Some([1; 32]),
        };
        assert_eq!(
            w.dialer.pair(&t, &code("7K4QM-2XD9P")).unwrap_err(),
            LinkError::Handshake
        );
        conn.join().unwrap();
    }

    #[test]
    fn unknown_ik_key_is_refused_before_app_data() {
        let w = world(25);
        let conn = plug(&w, "mem");
        let host_as_peer = StoredPeer {
            addrs: vec!["mem".into()],
            ..StoredPeer::new("this-pc", PeerKind::Desktop, &w.host_key.public(), 1)
        };
        let e = w
            .dialer
            .connect(&host_as_peer, &FakeDiscover::default(), &NoRelay)
            .unwrap_err();
        assert_eq!(e, LinkError::Denied);
        conn.join().unwrap();
        assert!(w.events.try_recv().is_err(), "no Connected event");
    }

    #[test]
    fn no_window_is_pair_code() {
        let w = world(26);
        *w.window.lock().unwrap() = None;
        let conn = plug(&w, "mem");
        assert_eq!(
            w.dialer.pair(&target(), &code("7K4QM-2XD9P")).unwrap_err(),
            LinkError::PairCode
        );
        conn.join().unwrap();
    }
}
