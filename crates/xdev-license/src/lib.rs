//! The desktop license: an offline check of a signed entitlement token, the device key in the
//! OS keychain, the feature registry and the calls to the entitlement service.
//!
//! Pure except `keystore.rs` (the keychain) and `cache.rs` (one file). No async and no HTTP
//! crate: every call goes through `xdev_id::Transport`, so tests never touch the network.
//! Never log a token, a private key or a nonce signature.

pub mod api;
pub mod b64;
pub mod cache;
pub mod certs;
pub mod claims;
pub mod cloud;
pub mod features;
pub mod grace;
pub mod jws;
pub mod keystore;
#[cfg(any(test, feature = "test-util"))]
pub mod mock;
pub mod roots;

/// The keychain entry of the device key (service `xdev_id::KEYRING_SERVICE`).
pub const KEYRING_USER: &str = "device-key";
/// Defined here, emitted by the desktop glue with the full `LicenseState`.
pub const CHANGED_EVENT: &str = "license://changed";
/// No OS keychain, or it refused: the device key cannot be stored.
pub const E_KEYCHAIN: &str = "license_keychain";
/// The service is unreachable or answered with something unexpected.
pub const E_UNAVAILABLE: &str = "license_unavailable";
/// The account removed this device.
pub const E_REVOKED: &str = "license_device_revoked";
/// Every Pro seat is in use on other devices.
pub const E_NO_SEAT: &str = "license_no_seat";
/// The yearly limit of Pro transfers is used up.
pub const E_TRANSFER_LIMIT: &str = "license_transfer_limit";
/// The service refused to register this device because it conflicts with another one.
pub const E_DEVICE_CONFLICT: &str = "license_device_conflict";
/// The token is not signed under a pinned root.
pub const E_SERVER_KEY: &str = "license_server_key";
/// Addition: the notice when a token belongs to another device.
pub const E_WRONG_DEVICE: &str = "license_wrong_device";

pub use api::{ApiError, BuildInfo, DeviceRow, Registered, TokenReply};
pub use cache::{Cache, read_cache, write_cache};
pub use certs::{KeySet, KeyUse};
pub use claims::{Claims, DevicesClaim, ProClaim, SyncClaim, TeamClaim, verify};
pub use cloud::{CloudConfig, effective_base, effective_roots, root_fingerprint};
pub use features::{PRO_FEATURES, SUB_FEATURES, allows};
pub use grace::{
    DeviceInfo, Freshness, LicenseState, ProInfo, TeamInfo, evaluate, parse_build_date,
    state_from_token,
};
pub use jws::VerifyError;
#[cfg(any(test, feature = "test-util"))]
pub use keystore::MemoryKeys;
pub use keystore::{DeviceKey, KeyStore, KeychainKeys, StoreError, proof_message};
#[cfg(any(test, feature = "test-util"))]
pub use mock::{MockEntitlementServer, MockMode};
