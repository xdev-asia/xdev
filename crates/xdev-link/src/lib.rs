//! The end-to-end encrypted link between xDev and the phones and desktops
//! paired with it.
//!
//! One identity key, one pairing flow, one peer store and one framed RPC
//! channel for both. Noise (through `snow`) does the encryption; a WebSocket
//! (sync `tungstenite`, no TLS) or a relay duplex only carries the bytes.
//! No Tauri, no async runtime and no license logic: the desktop glue owns
//! those.
//!
//! Nothing in this crate logs. Pairing codes, psks, keys, plaintext and
//! stream bytes stay out of every `Debug` impl and error message.

pub mod backoff;
pub mod clock;
pub mod dial;
pub mod discovery;
pub mod error;
pub mod frame;
pub mod identity;
pub mod limits;
pub mod link;
#[cfg(any(test, feature = "test-util"))]
pub mod mem;
pub mod net;
pub mod noise;
pub mod offer;
pub mod peers;
mod proto;
pub mod server;
pub mod types;
pub mod wire;

pub use backoff::Backoff;
pub use clock::{Clock, FakeClock, SystemClock};
pub use dial::{Connect, Dialer, NoRelay, PairTarget, PendingPair, RelayHook, WsConnect};
pub use discovery::{Discover, Discovery, FakeDiscover, Nearby};
pub use error::LinkError;
pub use frame::{Msg, RpcError};
pub use identity::{HostKey, KeyStore, KeyringStore, MemoryStore};
pub use limits::{Limits, TokenBucket};
pub use link::{Link, LinkOpts, PeerCtx, Serve};
pub use offer::{PairCode, PairOffer, PairWindow};
pub use peers::{PeerStore, StoredPeer};
pub use server::{Handle, Host, HostOpts, LinkEvent, ListenCfg, Listener};
pub use types::*;
pub use wire::{Duplex, StreamWire, Wire, WsWire};

/// Mixed into every Noise handshake, so a handshake for another protocol
/// never completes against this one.
pub const PROLOGUE: &[u8] = b"xdev-link/1";
