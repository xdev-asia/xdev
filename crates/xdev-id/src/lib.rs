//! xDev ID: the person's xDev account, signed in through the system browser.
//!
//! Everything here is plain Rust behind traits (`Transport`, `TokenStore`) so the
//! sign-in flow is tested with fakes: no network, no OS keychain. The token stays
//! in this crate's `Secret` and the keychain; the frontend only ever sees
//! `XdevIdState`.

use std::time::Duration;

pub mod avatar;
pub mod callback;
pub mod http;
pub mod link;
pub mod pkce;
pub mod server;
pub mod session;
pub mod store;
pub mod ureq_transport;

pub const DEFAULT_BASE: &str = "https://id.xdev.asia";
pub const KEYRING_SERVICE: &str = "xdev";
pub const KEYRING_USER: &str = "xdev-id";
pub const ATTEMPT_TTL: Duration = Duration::from_secs(10 * 60);
pub const REFRESH_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

// Error codes: the `CmdError.code` values and the notice values. Keep in sync
// with `ERROR_CODES` in the frontend `api.ts`.
/// The keychain is unreadable or unwritable.
pub const E_KEYCHAIN: &str = "account_keychain";
/// Network, timeout, 5xx or an unreadable reply.
pub const E_UNAVAILABLE: &str = "account_unavailable";
/// Not a valid `xdev://auth/callback` link.
pub const E_LINK: &str = "account_link";
/// No pending attempt, or another attempt's link.
pub const E_STATE: &str = "account_state";
/// The server said `invalid_code` (expired or used).
pub const E_CODE: &str = "account_code";
/// `/me` said 401.
pub const E_EXPIRED: &str = "account_expired";
/// The attempt is older than `ATTEMPT_TTL`.
pub const E_TIMEOUT: &str = "account_timeout";
/// The server setting is not an https (or loopback http) origin.
pub const E_SERVER: &str = "account_server";

pub use avatar::{AVATAR_MAX, avatar_allowed, data_url};
pub use callback::{Callback, parse_callback, same_state};
#[cfg(any(test, feature = "test-util"))]
pub use http::FakeTransport;
pub use http::{
    CallError, Me, Method, Offline, Request, Response, TokenReply, Transport, exchange,
    fetch_avatar, me, sign_out,
};
pub use link::{authorize_url, base_url, check_origin, clean_device, device_name};
pub use pkce::{PkcePair, Secret, b64url, random_43, random_pair, s256};
pub use server::{ServerSource, XdevIdServer, resolve_server};
pub use session::{Begin, Redeem, Session, XdevIdState, XdevIdUser};
pub use store::{
    Keychain, MemoryStore, StoreError, Stored, StoredUser, TokenStore, decode_stored, encode_stored,
};
pub use ureq_transport::UreqTransport;
