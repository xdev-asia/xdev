//! The dialing side: pairing with a host by code, and reconnecting to a
//! paired peer over IK.
//!
//! `connect` tries the addresses discovery last saw, then the stored ones,
//! then the relay. The first handshake that completes wins.

use std::net::{SocketAddr, TcpStream};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::discovery::Discover;
use crate::error::LinkError;
use crate::identity::HostKey;
use crate::link::{Link, LinkOpts, PeerCtx, Serve};
use crate::noise::{self, Session};
use crate::offer::{PairCode, PairOffer};
use crate::peers::{PeerStore, StoredPeer};
use crate::proto::{self, TAG_IK, TAG_PAIR_CODE};
use crate::types::{JoinTarget, PeerKind};
use crate::wire::{Duplex, POLL, StreamWire, Wire, WsWire};

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the joiner waits for the host's answer after confirming.
pub const CONFIRM_TIMEOUT: Duration = Duration::from_secs(125);

/// Opens a message wire to `addr`.
pub trait Connect: Send + Sync {
    fn connect(&self, addr: &str) -> Result<Box<dyn Wire>, LinkError>;
}

/// TCP and a WebSocket upgrade, no TLS (Noise encrypts).
#[derive(Debug, Default, Clone, Copy)]
pub struct WsConnect;

impl Connect for WsConnect {
    fn connect(&self, addr: &str) -> Result<Box<dyn Wire>, LinkError> {
        let sa: SocketAddr = addr.parse().map_err(|_| LinkError::Offline)?;
        let tcp =
            TcpStream::connect_timeout(&sa, CONNECT_TIMEOUT).map_err(|_| LinkError::Offline)?;
        tcp.set_read_timeout(Some(HANDSHAKE_TIMEOUT))?;
        tcp.set_write_timeout(Some(HANDSHAKE_TIMEOUT))?;
        let _ = tcp.set_nodelay(true);
        let (ws, _) =
            tungstenite::client(format!("ws://{sa}/"), tcp).map_err(|_| LinkError::Offline)?;
        ws.get_ref().set_read_timeout(Some(POLL))?;
        Ok(Box::new(WsWire::new(ws, Some(addr.to_owned()))))
    }
}

/// A way through when no direct address answers.
pub trait RelayHook: Send + Sync {
    fn open(&self, peer_id: &str) -> Result<Box<dyn Duplex>, LinkError>;
}

/// No relay in this build.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoRelay;

impl RelayHook for NoRelay {
    fn open(&self, _peer_id: &str) -> Result<Box<dyn Duplex>, LinkError> {
        Err(LinkError::Unsupported)
    }
}

/// Where a pairing goes, and the key the host must have when it is known.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairTarget {
    pub addrs: Vec<String>,
    pub host_pub: Option<[u8; 32]>,
}

impl PairTarget {
    pub fn from_offer(offer: &PairOffer) -> PairTarget {
        PairTarget {
            addrs: offer.candidates.clone(),
            host_pub: Some(offer.host_pub),
        }
    }

    pub fn from_join(
        target: &JoinTarget,
        discover: &dyn Discover,
        now_ms: u64,
    ) -> Result<PairTarget, LinkError> {
        match target {
            JoinTarget::Nearby { host_id } => {
                let addrs: Vec<String> = discover
                    .resolve(host_id)
                    .iter()
                    .map(SocketAddr::to_string)
                    .collect();
                if addrs.is_empty() {
                    return Err(LinkError::Offline);
                }
                Ok(PairTarget {
                    addrs,
                    host_pub: None,
                })
            }
            JoinTarget::Link { link } => {
                Ok(PairTarget::from_offer(&PairOffer::from_uri(link, now_ms)?))
            }
        }
    }
}

/// A pairing waiting for this side's yes or no. Compare `sas` with the host.
pub struct PendingPair {
    pub sas: String,
    pub host_name: String,
    pub host_pub: [u8; 32],
    wire: Box<dyn Wire>,
    session: Session,
    addr: Option<String>,
    store: Arc<PeerStore>,
    now_ms: u64,
    timeout: Duration,
}

impl std::fmt::Debug for PendingPair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PendingPair")
            .field("host_name", &self.host_name)
            .finish_non_exhaustive()
    }
}

impl PendingPair {
    /// Sends this side's answer and waits for the host's. On a yes from both,
    /// the host is stored with no role here; the caller grants one.
    pub fn finish(mut self, accept: bool) -> Result<StoredPeer, LinkError> {
        let w = self.wire.as_mut();
        proto::send_sealed(
            w,
            &mut self.session,
            proto::M_CONFIRM,
            json!({ "accept": accept }),
        )?;
        if !accept {
            w.close();
            return Err(LinkError::PairRejected);
        }
        let deadline = Instant::now() + self.timeout;
        let (m, p) = proto::recv_sealed(w, &mut self.session, deadline)?;
        w.close();
        if m != proto::M_RESULT || p.get("accept") != Some(&Value::Bool(true)) {
            return Err(LinkError::PairRejected);
        }
        let mut peer = StoredPeer::new(
            &self.host_name,
            PeerKind::Desktop,
            &self.host_pub,
            self.now_ms,
        );
        if let Some(old) = self.store.find_by_pub(&self.host_pub) {
            peer.role = old.role;
            peer.addrs = old.addrs;
        }
        let peer = self.store.add(peer)?;
        self.store
            .touch(&peer.id, self.addr.as_deref(), self.now_ms)
    }
}

pub struct Dialer {
    pub key: Arc<HostKey>,
    pub name: String,
    pub kind: PeerKind,
    pub store: Arc<PeerStore>,
    pub serve: Arc<dyn Serve>,
    pub connector: Box<dyn Connect>,
    pub opts: LinkOpts,
    pub handshake_timeout: Duration,
    pub confirm_timeout: Duration,
}

impl Dialer {
    pub fn new(
        key: Arc<HostKey>,
        name: &str,
        store: Arc<PeerStore>,
        serve: Arc<dyn Serve>,
    ) -> Dialer {
        Dialer {
            key,
            name: name.to_owned(),
            kind: PeerKind::Desktop,
            store,
            serve,
            connector: Box::new(WsConnect),
            opts: LinkOpts::default(),
            handshake_timeout: HANDSHAKE_TIMEOUT,
            confirm_timeout: CONFIRM_TIMEOUT,
        }
    }

    /// Runs XXpsk3 with the code's psk against the first address that
    /// answers. A wrong code fails here, before any SAS is shown.
    pub fn pair(&self, target: &PairTarget, code: &PairCode) -> Result<PendingPair, LinkError> {
        self.pair_with(target, TAG_PAIR_CODE, &code.psk())
    }

    pub(crate) fn pair_with(
        &self,
        target: &PairTarget,
        tag: u8,
        psk: &[u8; 32],
    ) -> Result<PendingPair, LinkError> {
        let mut last = LinkError::Offline;
        for addr in &target.addrs {
            let mut wire = match self.connector.connect(addr) {
                Ok(w) => w,
                Err(e) => {
                    last = e;
                    continue;
                }
            };
            match self.pair_over(wire.as_mut(), target, tag, psk) {
                Ok((session, host_name)) => {
                    return Ok(PendingPair {
                        sas: noise::sas(&session.hash),
                        host_pub: session.remote_pub,
                        host_name,
                        addr: wire.peer_addr(),
                        wire,
                        session,
                        store: self.store.clone(),
                        now_ms: self.opts.clock.now_ms(),
                        timeout: self.confirm_timeout,
                    });
                }
                // An answer from the host ends the search: another address
                // reaches the same host.
                Err(e @ (LinkError::PairCode | LinkError::PairBusy | LinkError::PairRejected)) => {
                    wire.close();
                    return Err(e);
                }
                Err(e) => {
                    wire.close();
                    last = e;
                }
            }
        }
        Err(last)
    }

    fn pair_over(
        &self,
        w: &mut dyn Wire,
        target: &PairTarget,
        tag: u8,
        psk: &[u8; 32],
    ) -> Result<(Session, String), LinkError> {
        let deadline = Instant::now() + self.handshake_timeout;
        let mut hs = noise::xx_psk_initiator(&self.key, psk)?;
        w.send(&proto::tagged(tag, &hs.write(&[])?))?;
        let payload = hs.read(&proto::recv_step(w, deadline)?)?;
        if let Some(want) = target.host_pub
            && hs.remote_static() != Some(want)
        {
            return Err(LinkError::Handshake);
        }
        let host_name = serde_json::from_slice::<Value>(&payload)
            .ok()
            .and_then(|v| v.get("n").and_then(Value::as_str).map(str::to_owned))
            .unwrap_or_default();
        let hello = json!({ "n": self.name, "k": self.kind });
        let msg3 = hs.write(&serde_json::to_vec(&hello).map_err(|_| LinkError::BadFrame)?)?;
        proto::send_ok(w, &msg3)?;
        let mut session = hs.finish()?;
        let (m, _) = proto::recv_sealed(w, &mut session, deadline)?;
        if m != proto::M_READY {
            return Err(LinkError::BadFrame);
        }
        Ok((session, host_name))
    }

    /// Reaches a paired peer: discovery's addresses, the stored ones, then
    /// the relay. `peer_denied` when the peer no longer knows this computer.
    pub fn connect(
        &self,
        peer: &StoredPeer,
        discover: &dyn Discover,
        relay: &dyn RelayHook,
    ) -> Result<Arc<Link>, LinkError> {
        let remote = peer.public().ok_or(LinkError::Handshake)?;
        let mut addrs: Vec<String> = discover
            .resolve(&peer.id)
            .iter()
            .map(SocketAddr::to_string)
            .collect();
        for a in &peer.addrs {
            if !addrs.contains(a) {
                addrs.push(a.clone());
            }
        }
        let mut last = LinkError::Offline;
        for addr in &addrs {
            let wire = match self.connector.connect(addr) {
                Ok(w) => w,
                Err(e) => {
                    last = e;
                    continue;
                }
            };
            match self.ik(wire, peer, &remote) {
                Ok(link) => return Ok(link),
                Err(LinkError::Denied) => return Err(LinkError::Denied),
                Err(e) => last = e,
            }
        }
        match relay.open(&peer.id) {
            Ok(io) => {
                let wire = StreamWire::new(io)?;
                self.ik(Box::new(wire), peer, &remote)
            }
            Err(LinkError::Unsupported) => Err(normalise(last)),
            Err(e) => Err(e),
        }
    }

    fn ik(
        &self,
        mut wire: Box<dyn Wire>,
        peer: &StoredPeer,
        remote: &[u8; 32],
    ) -> Result<Arc<Link>, LinkError> {
        let w = wire.as_mut();
        let deadline = Instant::now() + self.handshake_timeout;
        let session = (|| {
            let mut hs = noise::ik_initiator(&self.key, remote)?;
            w.send(&proto::tagged(TAG_IK, &hs.write(&[])?))?;
            hs.read(&proto::recv_step(w, deadline)?)?;
            hs.finish()
        })();
        let session = match session {
            Ok(s) => s,
            Err(e) => {
                wire.close();
                return Err(e);
            }
        };
        let addr = wire.peer_addr();
        let _ = self
            .store
            .touch(&peer.id, addr.as_deref(), self.opts.clock.now_ms());
        let ctx = PeerCtx::from_peer(peer).ok_or(LinkError::Handshake)?;
        Ok(Arc::new(Link::start(
            wire,
            session,
            ctx,
            self.serve.clone(),
            self.opts.clone(),
        )))
    }
}

/// A peer that did not answer at all is offline, whatever the last attempt said.
fn normalise(e: LinkError) -> LinkError {
    match e {
        LinkError::Io(_) | LinkError::Timeout | LinkError::Closed => LinkError::Offline,
        e => e,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery::{FakeDiscover, Nearby};
    use crate::link::tests::Echo;
    use crate::mem::MemConnect;
    use std::sync::Mutex;

    #[test]
    fn no_relay_is_unsupported() {
        assert_eq!(NoRelay.open("x").err(), Some(LinkError::Unsupported));
    }

    struct CountRelay(Mutex<Vec<String>>);
    impl RelayHook for CountRelay {
        fn open(&self, peer_id: &str) -> Result<Box<dyn Duplex>, LinkError> {
            self.0.lock().unwrap().push(peer_id.to_owned());
            Err(LinkError::Offline)
        }
    }

    #[test]
    fn connect_tries_discovery_then_stored_then_relay() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(PeerStore::open(&dir.path().join("peers.json")).unwrap());
        let key = Arc::new(HostKey::from_private([3; 32]).unwrap());
        let other = HostKey::from_private([4; 32]).unwrap();
        let mut peer = StoredPeer::new("box", PeerKind::Desktop, &other.public(), 1);
        peer.addrs = vec!["10.0.0.2:47821".into(), "10.0.0.9:47821".into()];
        let discover = FakeDiscover::with_hosts(vec![Nearby {
            host_id: peer.id.clone(),
            name: None,
            addrs: vec!["10.0.0.9:47821".parse().unwrap()],
            pairing: false,
        }]);
        let connector = MemConnect::default();
        let attempts = connector.attempts();
        let mut d = Dialer::new(key, "this-pc", store, Arc::new(Echo::default()));
        d.connector = Box::new(connector);

        let relay = CountRelay(Mutex::default());
        assert_eq!(
            d.connect(&peer, &discover, &relay).err(),
            Some(LinkError::Offline)
        );
        assert_eq!(
            attempts.lock().unwrap().as_slice(),
            ["10.0.0.9:47821", "10.0.0.2:47821"]
        );
        assert_eq!(relay.0.lock().unwrap().as_slice(), [peer.id.clone()]);

        assert_eq!(
            d.connect(&peer, &discover, &NoRelay).err(),
            Some(LinkError::Offline)
        );
    }

    #[test]
    fn join_target_from_nearby_and_link() {
        let host = HostKey::from_private([5; 32]).unwrap();
        let discover = FakeDiscover::with_hosts(vec![Nearby {
            host_id: host.host_id(),
            name: Some("build-box".into()),
            addrs: vec!["192.168.1.4:47821".parse().unwrap()],
            pairing: true,
        }]);
        let t = PairTarget::from_join(
            &JoinTarget::Nearby {
                host_id: host.host_id(),
            },
            &discover,
            0,
        )
        .unwrap();
        assert_eq!(t.addrs, ["192.168.1.4:47821"]);
        assert_eq!(t.host_pub, None);
        let missing = JoinTarget::Nearby {
            host_id: "nope".into(),
        };
        assert_eq!(
            PairTarget::from_join(&missing, &discover, 0).err(),
            Some(LinkError::Offline)
        );

        let w = crate::offer::PairWindow::new("build-box", 1_000).unwrap();
        let link = w
            .offer(host.public(), vec!["192.168.1.4:47821".into()])
            .to_uri();
        let t = PairTarget::from_join(&JoinTarget::Link { link }, &discover, 2_000).unwrap();
        assert_eq!(t.host_pub, Some(host.public()));
        assert_eq!(t.addrs, ["192.168.1.4:47821"]);
    }
}
