//! An established, encrypted session with one peer.
//!
//! One IO thread owns the wire and the Noise state: it sends what callers
//! queue, reads and decrypts, answers results to waiting calls, pings every
//! 20 s and drops the link after 45 s without a frame. A dispatch thread
//! hands requests, notices and stream bytes to `Serve` in arrival order.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, SyncSender, channel, sync_channel};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde_json::Value;

use crate::clock::{Clock, SystemClock};
use crate::error::LinkError;
use crate::frame::{self, Msg, RpcError, STREAM_CHUNK};
use crate::limits::Limits;
use crate::noise::Session;
use crate::types::{PeerKind, PeerRole};
use crate::wire::Wire;

pub const PING_MS: u64 = 20_000;
pub const DEAD_MS: u64 = 45_000;
/// Link-level notices; never passed to `Serve`.
const M_PING: &str = "ping";
const M_BYE: &str = "bye";

/// Who is on the other end, and what this computer lets them do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerCtx {
    pub peer_id: String,
    pub name: String,
    pub kind: PeerKind,
    pub role: PeerRole,
    pub remote_pub: [u8; 32],
}

impl PeerCtx {
    pub fn from_peer(p: &crate::peers::StoredPeer) -> Option<PeerCtx> {
        Some(PeerCtx {
            peer_id: p.id.clone(),
            name: p.name.clone(),
            kind: p.kind,
            role: p.role,
            remote_pub: p.public()?,
        })
    }

    /// `peer_role` unless this peer's role is `min` or above.
    pub fn require(&self, min: PeerRole) -> Result<(), RpcError> {
        if self.role.allows(min) {
            Ok(())
        } else {
            Err(RpcError::code("peer_role"))
        }
    }
}

/// What a link calls for traffic from the peer.
pub trait Serve: Send + Sync {
    fn call(&self, peer: &PeerCtx, m: &str, p: Value) -> Result<Value, RpcError>;
    fn on_notify(&self, _peer: &PeerCtx, _m: &str, _p: Value) {}
    fn on_stream(&self, peer: &PeerCtx, id: u32, bytes: &[u8]);
    fn on_close(&self, peer: &PeerCtx);
}

#[derive(Clone)]
pub struct LinkOpts {
    pub clock: Arc<dyn Clock>,
    pub ping_ms: u64,
    pub dead_ms: u64,
}

impl Default for LinkOpts {
    fn default() -> Self {
        LinkOpts {
            clock: Arc::new(SystemClock),
            ping_ms: PING_MS,
            dead_ms: DEAD_MS,
        }
    }
}

enum Out {
    Frame(Vec<u8>),
    Close,
}

type Reply = SyncSender<Result<Value, RpcError>>;

struct Shared {
    pending: Mutex<HashMap<u64, Reply>>,
    open: AtomicBool,
    done: Mutex<bool>,
    cv: Condvar,
    peer: Mutex<PeerCtx>,
}

pub struct Link {
    out: Sender<Out>,
    shared: Arc<Shared>,
    next_id: AtomicU64,
    next_stream: AtomicU32,
}

impl std::fmt::Debug for Link {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Link")
            .field("peer", &self.peer().peer_id)
            .field("open", &self.is_open())
            .finish()
    }
}

impl Link {
    pub fn start(
        wire: Box<dyn Wire>,
        session: Session,
        peer: PeerCtx,
        serve: Arc<dyn Serve>,
        opts: LinkOpts,
    ) -> Link {
        let (out_tx, out_rx) = channel();
        let (in_tx, in_rx) = channel();
        // The dialer's streams are odd and the host's even, so ids never clash.
        let first_stream = if session.is_initiator() { 1 } else { 2 };
        let shared = Arc::new(Shared {
            pending: Mutex::default(),
            open: AtomicBool::new(true),
            done: Mutex::new(false),
            cv: Condvar::new(),
            peer: Mutex::new(peer),
        });
        {
            let shared = shared.clone();
            let out = out_tx.clone();
            let limits = Limits::new(opts.clock.clone());
            let _ = std::thread::Builder::new()
                .name("xdev-link-dispatch".into())
                .spawn(move || dispatch(in_rx, out, serve, shared, limits));
        }
        {
            let shared = shared.clone();
            // Read here, not on the thread: a clock that moves before the
            // thread starts must still count from the link's start.
            let started = opts.clock.now_ms();
            let _ = std::thread::Builder::new()
                .name("xdev-link-io".into())
                .spawn(move || io_loop(wire, session, out_rx, in_tx, shared, opts, started));
        }
        Link {
            out: out_tx,
            shared,
            next_id: AtomicU64::new(1),
            next_stream: AtomicU32::new(first_stream),
        }
    }

    pub fn peer(&self) -> PeerCtx {
        self.shared
            .peer
            .lock()
            .map(|p| p.clone())
            .unwrap_or_else(|p| p.into_inner().clone())
    }

    /// Changes what the peer may do from the next request on.
    pub fn set_role(&self, role: PeerRole) {
        if let Ok(mut p) = self.shared.peer.lock() {
            p.role = role;
        }
    }

    pub fn is_open(&self) -> bool {
        self.shared.open.load(Ordering::SeqCst)
    }

    fn send(&self, msg: &Msg) -> Result<(), LinkError> {
        if !self.is_open() {
            return Err(LinkError::Closed);
        }
        let bytes = frame::encode(msg)?;
        self.out
            .send(Out::Frame(bytes))
            .map_err(|_| LinkError::Closed)
    }

    pub fn call(&self, m: &str, p: Value, timeout: Duration) -> Result<Value, RpcError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = sync_channel(1);
        if let Ok(mut pending) = self.shared.pending.lock() {
            pending.insert(id, tx);
        }
        let sent = self.send(&Msg::Req {
            id: Some(id),
            m: m.to_owned(),
            p,
        });
        if let Err(e) = sent {
            self.forget(id);
            return Err(RpcError::code(e.code()));
        }
        match rx.recv_timeout(timeout) {
            Ok(r) => r,
            Err(RecvTimeoutError::Timeout) => {
                self.forget(id);
                Err(RpcError::code("timeout"))
            }
            Err(RecvTimeoutError::Disconnected) => Err(RpcError::code("closed")),
        }
    }

    fn forget(&self, id: u64) {
        if let Ok(mut pending) = self.shared.pending.lock() {
            pending.remove(&id);
        }
    }

    pub fn notify(&self, m: &str, p: Value) -> Result<(), LinkError> {
        self.send(&Msg::Req {
            id: None,
            m: m.to_owned(),
            p,
        })
    }

    /// A new stream id for this side. The peer learns it from an RPC result.
    pub fn open_stream(&self) -> u32 {
        self.next_stream.fetch_add(2, Ordering::SeqCst)
    }

    /// Sends `bytes`, split into frames of at most `STREAM_CHUNK`.
    pub fn send_stream(&self, id: u32, bytes: &[u8]) -> Result<(), LinkError> {
        if bytes.is_empty() {
            return self.send(&Msg::Stream {
                id,
                data: Vec::new(),
            });
        }
        for chunk in bytes.chunks(STREAM_CHUNK) {
            self.send(&Msg::Stream {
                id,
                data: chunk.to_vec(),
            })?;
        }
        Ok(())
    }

    /// Says `bye` and closes. Calls in flight fail with `closed`.
    pub fn close(&self) {
        if self.is_open() {
            let _ = self.notify(M_BYE, Value::Null);
            let _ = self.out.send(Out::Close);
        }
    }

    /// Blocks until the link has closed.
    pub fn wait(&self) {
        let mut done = self.shared.done.lock().unwrap_or_else(|p| p.into_inner());
        while !*done {
            done = self.shared.cv.wait(done).unwrap_or_else(|p| p.into_inner());
        }
    }

    /// `true` when the link closed within `d`.
    pub fn wait_timeout(&self, d: Duration) -> bool {
        let done = self.shared.done.lock().unwrap_or_else(|p| p.into_inner());
        let (done, _) = self
            .shared
            .cv
            .wait_timeout_while(done, d, |d| !*d)
            .unwrap_or_else(|p| p.into_inner());
        *done
    }
}

impl Drop for Link {
    fn drop(&mut self) {
        self.close();
    }
}

fn io_loop(
    mut wire: Box<dyn Wire>,
    mut session: Session,
    out_rx: Receiver<Out>,
    in_tx: Sender<Msg>,
    shared: Arc<Shared>,
    opts: LinkOpts,
    started: u64,
) {
    let clock = opts.clock;
    let mut last_rx = started;
    let mut last_ping = last_rx;
    'outer: loop {
        loop {
            match out_rx.try_recv() {
                Ok(Out::Frame(plain)) => {
                    let sent = session
                        .encrypt(&plain)
                        .and_then(|c| wire.send(&c).map_err(LinkError::from));
                    if sent.is_err() {
                        break 'outer;
                    }
                }
                Ok(Out::Close) => break 'outer,
                Err(std::sync::mpsc::TryRecvError::Empty) => break,
                Err(std::sync::mpsc::TryRecvError::Disconnected) => break 'outer,
            }
        }
        match wire.poll() {
            Ok(Some(cipher)) => {
                last_rx = clock.now_ms();
                let Ok(plain) = session.decrypt(&cipher) else {
                    break;
                };
                match frame::decode(&plain) {
                    Ok(Msg::Res { id, r }) => answer(&shared, id, Ok(r)),
                    Ok(Msg::Err { id, e }) => answer(&shared, id, Err(e)),
                    Ok(Msg::Req { m, .. }) if m == M_PING => {}
                    Ok(Msg::Req { m, .. }) if m == M_BYE => break,
                    Ok(msg) => {
                        if in_tx.send(msg).is_err() {
                            break;
                        }
                    }
                    // A frame this side does not understand is skipped.
                    Err(_) => {}
                }
            }
            Ok(None) => {}
            Err(_) => break,
        }
        let now = clock.now_ms();
        if now.saturating_sub(last_rx) >= opts.dead_ms {
            break;
        }
        if now.saturating_sub(last_ping) >= opts.ping_ms {
            last_ping = now;
            let ping = frame::encode(&Msg::Req {
                id: None,
                m: M_PING.into(),
                p: Value::Null,
            });
            let sent = ping
                .and_then(|p| session.encrypt(&p))
                .and_then(|c| wire.send(&c).map_err(LinkError::from));
            if sent.is_err() {
                break;
            }
        }
    }
    shared.open.store(false, Ordering::SeqCst);
    wire.close();
    drop(in_tx);
    if let Ok(mut pending) = shared.pending.lock() {
        for (_, tx) in pending.drain() {
            let _ = tx.try_send(Err(RpcError::code("closed")));
        }
    }
}

fn answer(shared: &Shared, id: u64, r: Result<Value, RpcError>) {
    let tx = shared.pending.lock().ok().and_then(|mut p| p.remove(&id));
    if let Some(tx) = tx {
        let _ = tx.try_send(r);
    }
}

fn dispatch(
    in_rx: Receiver<Msg>,
    out: Sender<Out>,
    serve: Arc<dyn Serve>,
    shared: Arc<Shared>,
    mut limits: Limits,
) {
    let peer = |s: &Shared| {
        s.peer
            .lock()
            .map(|p| p.clone())
            .unwrap_or_else(|p| p.into_inner().clone())
    };
    while let Ok(msg) = in_rx.recv() {
        let ctx = peer(&shared);
        match msg {
            Msg::Req { id: Some(id), m, p } => {
                let r = if limits.allow_rpc() {
                    serve.call(&ctx, &m, p)
                } else {
                    Err(RpcError::code("rate_limited"))
                };
                let reply = match r {
                    Ok(r) => Msg::Res { id, r },
                    Err(e) => Msg::Err { id, e },
                };
                let bytes = frame::encode(&reply).or_else(|_| {
                    frame::encode(&Msg::Err {
                        id,
                        e: RpcError::code("too_large"),
                    })
                });
                if let Ok(bytes) = bytes {
                    let _ = out.send(Out::Frame(bytes));
                }
            }
            Msg::Req { id: None, m, p } => serve.on_notify(&ctx, &m, p),
            Msg::Stream { id, data } => serve.on_stream(&ctx, id, &data),
            Msg::Res { .. } | Msg::Err { .. } => {}
        }
    }
    serve.on_close(&peer(&shared));
    // Wakes `wait` only after `on_close`, so a caller sees the cleanup done.
    let mut done = shared.done.lock().unwrap_or_else(|p| p.into_inner());
    *done = true;
    shared.cv.notify_all();
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::clock::FakeClock;
    use crate::identity::HostKey;
    use crate::mem::{PipeWire, pipe};
    use crate::noise;
    use serde_json::json;

    /// Records what reaches it; `fail` makes Operator methods need Operator.
    #[derive(Default)]
    pub(crate) struct Echo {
        pub streams: Mutex<Vec<(u32, Vec<u8>)>>,
        pub notices: Mutex<Vec<String>>,
        pub closed: AtomicBool,
    }

    impl Serve for Echo {
        fn call(&self, peer: &PeerCtx, m: &str, p: Value) -> Result<Value, RpcError> {
            match m {
                "echo" => Ok(p),
                "write" => {
                    peer.require(PeerRole::Operator)?;
                    Ok(json!({"ok": true}))
                }
                _ => Err(RpcError::code("unknown_method")),
            }
        }
        fn on_notify(&self, _peer: &PeerCtx, m: &str, _p: Value) {
            self.notices.lock().unwrap().push(m.to_owned());
        }
        fn on_stream(&self, _peer: &PeerCtx, id: u32, bytes: &[u8]) {
            self.streams.lock().unwrap().push((id, bytes.to_vec()));
        }
        fn on_close(&self, _peer: &PeerCtx) {
            self.closed.store(true, Ordering::SeqCst);
        }
    }

    pub(crate) fn sessions() -> (Session, Session) {
        let a = HostKey::from_private([1; 32]).unwrap();
        let b = HostKey::from_private([2; 32]).unwrap();
        let mut i = noise::ik_initiator(&a, &b.public()).unwrap();
        let mut r = noise::ik_responder(&b).unwrap();
        r.read(&i.write(b"").unwrap()).unwrap();
        i.read(&r.write(b"").unwrap()).unwrap();
        (i.finish().unwrap(), r.finish().unwrap())
    }

    pub(crate) fn ctx(role: PeerRole) -> PeerCtx {
        PeerCtx {
            peer_id: "p".into(),
            name: "studio-mac".into(),
            kind: PeerKind::Desktop,
            role,
            remote_pub: [0; 32],
        }
    }

    fn pair_links(role: PeerRole) -> (Link, Link, Arc<Echo>, Arc<Echo>) {
        let (wa, wb) = pipe();
        let (sa, sb) = sessions();
        let ea = Arc::new(Echo::default());
        let eb = Arc::new(Echo::default());
        let a = Link::start(Box::new(wa), sa, ctx(role), ea.clone(), LinkOpts::default());
        let b = Link::start(Box::new(wb), sb, ctx(role), eb.clone(), LinkOpts::default());
        (a, b, ea, eb)
    }

    const T: Duration = Duration::from_secs(5);

    #[test]
    fn call_notify_stream_round_trip() {
        let (a, b, ea, eb) = pair_links(PeerRole::Viewer);
        assert_eq!(a.call("echo", json!({"x": 1}), T).unwrap(), json!({"x": 1}));
        assert_eq!(b.call("echo", Value::Null, T).unwrap(), Value::Null);
        assert_eq!(
            a.call("nope", Value::Null, T).unwrap_err().code,
            "unknown_method"
        );

        a.notify("hello", json!({})).unwrap();
        let sid = a.open_stream();
        assert_eq!(sid % 2, 1);
        assert_eq!(b.open_stream() % 2, 0);
        let big = vec![7u8; STREAM_CHUNK + 10];
        a.send_stream(sid, &big).unwrap();
        // A call after the stream returns once the stream frames before it were handled.
        a.call("echo", Value::Null, T).unwrap();
        let got = eb.streams.lock().unwrap().clone();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].1.len() + got[1].1.len(), big.len());
        assert_eq!(eb.notices.lock().unwrap().as_slice(), ["hello"]);

        a.close();
        assert!(b.wait_timeout(T));
        assert!(a.wait_timeout(T));
        assert!(ea.closed.load(Ordering::SeqCst));
        assert!(eb.closed.load(Ordering::SeqCst));
        assert_eq!(a.call("echo", Value::Null, T).unwrap_err().code, "closed");
    }

    #[test]
    fn role_errors_pass_through() {
        let (a, b, _, _) = pair_links(PeerRole::Viewer);
        let e = a.call("write", Value::Null, T).unwrap_err();
        assert_eq!(e.code, "peer_role");
        b.set_role(PeerRole::Operator);
        assert_eq!(
            a.call("write", Value::Null, T).unwrap(),
            json!({"ok": true})
        );
    }

    #[test]
    fn rate_limited_after_a_burst() {
        let (wa, wb) = pipe();
        let (sa, sb) = sessions();
        // The clock stands still, so the 20/s bucket never refills.
        let clock: Arc<dyn Clock> = Arc::new(FakeClock::new(1_000));
        let opts = LinkOpts {
            clock,
            ..LinkOpts::default()
        };
        let echo: Arc<dyn Serve> = Arc::new(Echo::default());
        let a = Link::start(
            Box::new(wa),
            sa,
            ctx(PeerRole::Viewer),
            echo.clone(),
            opts.clone(),
        );
        let _b = Link::start(Box::new(wb), sb, ctx(PeerRole::Viewer), echo, opts);
        let codes: Vec<String> = (0..25)
            .map(|_| match a.call("echo", Value::Null, T) {
                Ok(_) => "ok".into(),
                Err(e) => e.code,
            })
            .collect();
        assert_eq!(codes.iter().filter(|c| *c == "ok").count(), 20, "{codes:?}");
        assert_eq!(codes[24], "rate_limited");
    }

    #[test]
    fn pings_then_drops_a_silent_peer() {
        let (wa, mut wb): (PipeWire, PipeWire) = pipe();
        let (sa, mut sb) = sessions();
        let clock = FakeClock::new(1_000);
        let echo = Arc::new(Echo::default());
        let a = Link::start(
            Box::new(wa),
            sa,
            ctx(PeerRole::Viewer),
            echo.clone(),
            LinkOpts {
                clock: Arc::new(clock.clone()),
                ..LinkOpts::default()
            },
        );
        clock.advance(PING_MS + 1);
        let deadline = std::time::Instant::now() + T;
        let ping = loop {
            if let Some(m) = wb.poll().unwrap() {
                break m;
            }
            assert!(std::time::Instant::now() < deadline, "no ping");
        };
        let plain = sb.decrypt(&ping).unwrap();
        assert!(matches!(frame::decode(&plain).unwrap(), Msg::Req { m, .. } if m == "ping"));
        assert!(a.is_open());

        clock.advance(DEAD_MS);
        assert!(a.wait_timeout(T), "a silent peer is dropped after 45 s");
        assert!(!a.is_open());
        assert!(echo.closed.load(Ordering::SeqCst));
    }

    #[test]
    fn call_times_out() {
        let (wa, _wb) = pipe();
        let (sa, _sb) = sessions();
        let a = Link::start(
            Box::new(wa),
            sa,
            ctx(PeerRole::Viewer),
            Arc::new(Echo::default()),
            LinkOpts::default(),
        );
        let e = a.call("echo", Value::Null, Duration::from_millis(50));
        assert_eq!(e.unwrap_err().code, "timeout");
    }
}
