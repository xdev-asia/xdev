//! An in-memory entitlement service for tests (feature `test-util`). It answers the same
//! `/v1/*` calls as the real one, through `xdev_id::Transport`, so no test opens a socket.
//!
//! The root is RFC 8032 test 1 (`roots::BUILTIN_ROOTS` under test-util); the signing key is
//! RFC 8032 test 2, certified by that root. `now` is injected.

use std::sync::Mutex;

use serde_json::{Value, json};
use xdev_id::{Method, Offline, Request, Response, Transport};

use crate::b64;
use crate::certs::{KeyUse, sign_cert};
use crate::claims::{AUD, Claims, DevicesClaim, ProClaim, sign_token};
use crate::features::SERVER_PRO_FEATURES;
use crate::keystore::{DEVICE_PROOF, ENT_PROOF, proof_message};
use crate::roots::RFC8032_TEST1_SEED;

pub const MOCK_BASE: &str = "https://id.mock.test";
pub const MOCK_UID: &str = "mock-user";
pub const MOCK_BEARER: &str = "mock-session-token-0123456789";
pub const MOCK_KID: &str = "ent-mock";
/// The server's limits.
pub const TOKEN_LIFETIME_S: i64 = 14 * 86_400;
pub const REFRESH_AFTER_S: i64 = 86_400;
pub const TRANSFER_LIMIT: u32 = 3;
pub const MAX_DEVICES: usize = 10;

/// RFC 8032 section 7.1, test 2: the seed of the mock signing key.
const SIGNING_SEED: [u8; 32] = [
    0x4c, 0xcd, 0x08, 0x9b, 0x28, 0xff, 0x96, 0xda, 0x9d, 0xb6, 0xc3, 0x46, 0xec, 0x11, 0x4e, 0x0f,
    0x5b, 0x8a, 0x31, 0x9f, 0x35, 0xab, 0xa6, 0x24, 0xda, 0x8c, 0xf6, 0xed, 0x4f, 0xb8, 0xa6, 0xfb,
];
/// Not a pinned root: what `BadRoot` certifies with.
const STRANGER_ROOT_SEED: [u8; 32] = [0x5a; 32];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MockMode {
    /// No grant: tokens say `free`, activation is `no_grant`.
    Free,
    /// One Pro grant with 2 seats, none in use.
    Pro,
    /// One Pro grant with 1 seat, held by another device.
    ProNoSeat,
    /// Pro, but this year's transfers are used up.
    TransferLimit,
    /// Every device is revoked as soon as it registers.
    Revoked,
    /// Every call fails as if the network were down.
    Offline,
    /// Certificates signed by a root the client does not pin.
    BadRoot,
}

#[derive(Clone, Debug)]
struct Device {
    id: String,
    public: [u8; 32],
    fingerprint: String,
    name: String,
    platform: String,
    created_at: i64,
    last_seen_at: i64,
    revoked_at: Option<i64>,
}

#[derive(Clone, Debug)]
struct Grant {
    id: String,
    seats: u32,
    updates_until: Option<i64>,
}

#[derive(Debug)]
struct State {
    mode: MockMode,
    now: i64,
    counter: u64,
    nonces: Vec<String>,
    devices: Vec<Device>,
    grants: Vec<Grant>,
    /// (grant id, device id), active only.
    activations: Vec<(String, String)>,
    transfers: u32,
}

pub struct MockEntitlementServer {
    state: Mutex<State>,
}

fn reply(status: u16, body: Value) -> Response {
    Response {
        status,
        content_type: Some("application/json".to_owned()),
        body: body.to_string().into_bytes(),
    }
}

fn err(status: u16, name: &str) -> Response {
    reply(status, json!({ "error": name }))
}

fn no_content() -> Response {
    Response {
        status: 204,
        content_type: None,
        body: Vec::new(),
    }
}

fn fingerprint_of(public: &[u8; 32]) -> String {
    use sha2::{Digest, Sha256};
    let mut fp = b64::encode(&Sha256::digest(public));
    fp.truncate(22);
    fp
}

fn proof_ok(public: &[u8; 32], purpose: &str, nonce: &str, sig: &str) -> bool {
    use ed25519_dalek::{Signature, VerifyingKey};
    let Some(sig) = b64::decode(sig).and_then(|s| Signature::from_slice(&s).ok()) else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(public) else {
        return false;
    };
    key.verify_strict(proof_message(purpose, nonce, MOCK_UID).as_bytes(), &sig)
        .is_ok()
}

impl MockEntitlementServer {
    pub fn new(mode: MockMode, now: i64) -> MockEntitlementServer {
        let mut st = State {
            mode,
            now,
            counter: 0,
            nonces: Vec::new(),
            devices: Vec::new(),
            grants: Vec::new(),
            activations: Vec::new(),
            transfers: 0,
        };
        match mode {
            MockMode::Free | MockMode::Offline => {}
            MockMode::Pro | MockMode::Revoked | MockMode::BadRoot => {
                st.grants.push(Grant {
                    id: "grant-pro".into(),
                    seats: 2,
                    updates_until: None,
                });
            }
            MockMode::TransferLimit => {
                st.grants.push(Grant {
                    id: "grant-pro".into(),
                    seats: 2,
                    updates_until: None,
                });
                st.transfers = TRANSFER_LIMIT;
            }
            MockMode::ProNoSeat => {
                st.grants.push(Grant {
                    id: "grant-pro".into(),
                    seats: 1,
                    updates_until: None,
                });
                st.devices.push(Device {
                    id: "device-other".into(),
                    public: [0u8; 32],
                    fingerprint: "OTHERDEVICEFINGERPRINT".into(),
                    name: "Other".into(),
                    platform: "linux".into(),
                    created_at: now,
                    last_seen_at: now,
                    revoked_at: None,
                });
                st.activations
                    .push(("grant-pro".into(), "device-other".into()));
            }
        }
        MockEntitlementServer {
            state: Mutex::new(st),
        }
    }

    pub fn base(&self) -> &'static str {
        MOCK_BASE
    }

    pub fn now(&self) -> i64 {
        self.lock().now
    }

    pub fn set_now(&self, now: i64) {
        self.lock().now = now;
    }

    pub fn set_mode(&self, mode: MockMode) {
        self.lock().mode = mode;
    }

    /// The account side: revokes a device, as the portal would.
    pub fn revoke(&self, device_id: &str) {
        let mut st = self.lock();
        let now = st.now;
        if let Some(d) = st.devices.iter_mut().find(|d| d.id == device_id) {
            d.revoked_at.get_or_insert(now);
        }
        st.activations.retain(|(_, d)| d != device_id);
    }

    pub fn transfers(&self) -> u32 {
        self.lock().transfers
    }

    pub fn active_seats(&self) -> usize {
        self.lock().activations.len()
    }

    /// Sets the Pro grant's `updates_until`.
    pub fn set_updates_until(&self, until: Option<i64>) {
        for g in &mut self.lock().grants {
            g.updates_until = until;
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn certs(st: &State) -> Vec<String> {
        let root = if st.mode == MockMode::BadRoot {
            STRANGER_ROOT_SEED
        } else {
            RFC8032_TEST1_SEED
        };
        let public = ed25519_dalek::SigningKey::from_bytes(&SIGNING_SEED)
            .verifying_key()
            .to_bytes();
        vec![sign_cert(
            MOCK_KID,
            KeyUse::Ent,
            &public,
            0,
            i64::MAX,
            &root,
        )]
    }

    fn route(&self, req: &Request) -> Response {
        let Some(path) = req.url.strip_prefix(MOCK_BASE) else {
            return err(404, "not_found");
        };
        if req.bearer.as_ref().map(xdev_id::Secret::expose) != Some(MOCK_BEARER) {
            return err(401, "unauthorized");
        }
        let body: Value = req
            .json
            .as_ref()
            .and_then(|j| serde_json::from_str(j.expose()).ok())
            .unwrap_or(Value::Null);
        let mut st = self.lock();
        match (req.method, path) {
            (Method::Post, "/v1/devices/challenge") => {
                st.counter += 1;
                let nonce = format!("{:0>43}", st.counter);
                st.nonces.push(nonce.clone());
                reply(200, json!({ "nonce": nonce }))
            }
            (Method::Post, "/v1/devices") => register(&mut st, &body),
            (Method::Get, "/v1/devices") => list(&st),
            (Method::Post, "/v1/entitlement") => entitlement(&mut st, &body),
            (Method::Post, "/v1/activations") => activate(&mut st, &body),
            (Method::Get, "/v1/keys") => reply(200, json!({ "certs": Self::certs(&st) })),
            (Method::Delete, p) => {
                if let Some(id) = p.strip_prefix("/v1/activations/") {
                    deactivate(&mut st, id)
                } else if let Some(id) = p.strip_prefix("/v1/devices/") {
                    remove(&mut st, id)
                } else {
                    err(404, "not_found")
                }
            }
            _ => err(404, "not_found"),
        }
    }
}

fn spend(st: &mut State, nonce: &str) -> bool {
    let before = st.nonces.len();
    st.nonces.retain(|n| n != nonce);
    st.nonces.len() != before
}

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key)?.as_str()
}

fn register(st: &mut State, body: &Value) -> Response {
    let public = str_of(body, "pub").and_then(b64::decode_32);
    let (Some(public), Some(nonce), Some(sig)) =
        (public, str_of(body, "nonce"), str_of(body, "sig"))
    else {
        return err(400, "bad_request");
    };
    if nonce.len() != 43 {
        return err(400, "bad_request");
    }
    if !spend(st, nonce) {
        return err(400, "bad_nonce");
    }
    if !proof_ok(&public, DEVICE_PROOF, nonce, sig) {
        return err(400, "bad_signature");
    }
    let fp = fingerprint_of(&public);
    let now = st.now;
    if let Some(d) = st.devices.iter_mut().find(|d| d.fingerprint == fp) {
        if d.revoked_at.is_some() {
            return err(403, "device_revoked");
        }
        d.last_seen_at = now;
        return reply(200, json!({ "id": d.id, "fingerprint": fp }));
    }
    if st.devices.iter().filter(|d| d.revoked_at.is_none()).count() >= MAX_DEVICES {
        return err(409, "device_limit");
    }
    st.counter += 1;
    let id = format!("device-{}", st.counter);
    let revoked_at = (st.mode == MockMode::Revoked).then_some(now);
    st.devices.push(Device {
        id: id.clone(),
        public,
        fingerprint: fp.clone(),
        name: str_of(body, "name").unwrap_or("Unknown device").to_owned(),
        platform: str_of(body, "platform").unwrap_or("unknown").to_owned(),
        created_at: now,
        last_seen_at: now,
        revoked_at,
    });
    reply(200, json!({ "id": id, "fingerprint": fp }))
}

fn list(st: &State) -> Response {
    let rows: Vec<Value> = st
        .devices
        .iter()
        .map(|d| {
            let grant = st
                .activations
                .iter()
                .find(|(_, dev)| *dev == d.id)
                .map(|(g, _)| g.clone());
            json!({
                "id": d.id,
                "name": d.name,
                "platform": d.platform,
                "fingerprint": d.fingerprint,
                "created_at": d.created_at,
                "last_seen_at": d.last_seen_at,
                "revoked_at": d.revoked_at,
                "pro_grant": grant,
            })
        })
        .collect();
    reply(200, json!({ "devices": rows }))
}

fn entitlement(st: &mut State, body: &Value) -> Response {
    let (Some(device_id), Some(nonce), Some(sig)) = (
        str_of(body, "device_id"),
        str_of(body, "nonce"),
        str_of(body, "sig"),
    ) else {
        return err(400, "bad_request");
    };
    let Some(device) = st
        .devices
        .iter()
        .find(|d| d.id == device_id && d.revoked_at.is_none())
        .cloned()
    else {
        return err(403, "device_revoked");
    };
    if !spend(st, nonce) {
        return err(400, "bad_nonce");
    }
    if !proof_ok(&device.public, ENT_PROOF, nonce, sig) {
        return err(400, "bad_signature");
    }
    let now = st.now;
    let active_on = |g: &Grant| {
        st.activations
            .iter()
            .filter(|(gid, _)| *gid == g.id)
            .count()
    };
    let pro = st
        .grants
        .iter()
        .find(|g| st.activations.contains(&(g.id.clone(), device.id.clone())));
    let devices_grant = pro.or(st.grants.first());
    let devices = devices_grant.map_or(DevicesClaim { max: 0, active: 0 }, |g| DevicesClaim {
        max: g.seats,
        active: u32::try_from(active_on(g)).unwrap_or(u32::MAX),
    });
    let mut features: Vec<String> = Vec::new();
    if pro.is_some() {
        features = SERVER_PRO_FEATURES
            .iter()
            .map(|f| (*f).to_owned())
            .collect();
        features.sort();
    }
    st.counter += 1;
    let claims = Claims {
        iss: MOCK_BASE.to_owned(),
        aud: AUD.to_owned(),
        sub: MOCK_UID.to_owned(),
        jti: format!("jti-{}", st.counter),
        iat: now,
        nbf: now,
        exp: now + TOKEN_LIFETIME_S,
        rfa: now + REFRESH_AFTER_S,
        dev: device.fingerprint.clone(),
        plan: vec![if pro.is_some() { "pro" } else { "free" }.to_owned()],
        features,
        pro: pro.map(|g| ProClaim {
            grant: g.id.clone(),
            perpetual: true,
            updates_until: g.updates_until,
        }),
        sync: None,
        team: None,
        devices,
    };
    let token = sign_token(&claims, MOCK_KID, &SIGNING_SEED);
    if let Some(d) = st.devices.iter_mut().find(|d| d.id == device.id) {
        d.last_seen_at = now;
    }
    reply(
        200,
        json!({ "token": token, "certs": MockEntitlementServer::certs(st), "refresh_after": claims.rfa }),
    )
}

fn activate(st: &mut State, body: &Value) -> Response {
    let Some(device_id) = str_of(body, "device_id") else {
        return err(400, "bad_request");
    };
    if !st
        .devices
        .iter()
        .any(|d| d.id == device_id && d.revoked_at.is_none())
    {
        return err(404, "not_found");
    }
    if let Some((g, _)) = st.activations.iter().find(|(_, d)| d == device_id) {
        return reply(200, json!({ "grant_id": g }));
    }
    let free = st.grants.iter().find(|g| {
        let used = st
            .activations
            .iter()
            .filter(|(gid, _)| *gid == g.id)
            .count();
        usize::try_from(g.seats).unwrap_or(usize::MAX) > used
    });
    let Some(grant) = free.map(|g| g.id.clone()) else {
        return if st.grants.is_empty() {
            err(404, "no_grant")
        } else {
            err(409, "no_free_seat")
        };
    };
    st.activations.push((grant.clone(), device_id.to_owned()));
    reply(201, json!({ "grant_id": grant }))
}

fn deactivate(st: &mut State, device_id: &str) -> Response {
    let Some(at) = st.activations.iter().position(|(_, d)| d == device_id) else {
        return err(404, "not_found");
    };
    if st.transfers >= TRANSFER_LIMIT {
        return reply(
            429,
            json!({ "error": "transfer_limit", "limit": TRANSFER_LIMIT }),
        );
    }
    st.activations.remove(at);
    st.transfers += 1;
    no_content()
}

fn remove(st: &mut State, id: &str) -> Response {
    let now = st.now;
    let Some(d) = st.devices.iter_mut().find(|d| d.id == id) else {
        return err(404, "not_found");
    };
    d.revoked_at.get_or_insert(now);
    st.activations.retain(|(_, dev)| dev != id);
    no_content()
}

impl Transport for MockEntitlementServer {
    fn send(&self, req: &Request) -> Result<Response, Offline> {
        if self.lock().mode == MockMode::Offline {
            return Err(Offline);
        }
        Ok(self.route(req))
    }
}

#[cfg(test)]
mod tests {
    use xdev_id::Secret;

    use super::*;
    use crate::api::{self, ApiError, BuildInfo};
    use crate::certs::KeySet;
    use crate::grace::{Freshness, LicenseState, state_from_token};
    use crate::keystore::DeviceKey;
    use crate::roots::BUILTIN_ROOTS;
    use crate::{E_NO_SEAT, E_REVOKED, E_SERVER_KEY, E_TRANSFER_LIMIT, allows};

    const NOW: i64 = 1_800_000_000;
    const BUILD: i64 = NOW - 86_400;

    fn bearer() -> Secret {
        Secret::new(MOCK_BEARER.to_owned())
    }

    fn build() -> BuildInfo {
        BuildInfo {
            version: "1.0.0".into(),
            date: BUILD,
        }
    }

    /// challenge → register → challenge → entitlement, as the desktop does on first sign-in.
    fn sign_in(
        srv: &MockEntitlementServer,
        key: &DeviceKey,
    ) -> Result<(String, api::TokenReply), ApiError> {
        let b = bearer();
        let nonce = api::challenge(srv, MOCK_BASE, &b)?;
        let reg = api::register(
            srv, MOCK_BASE, &b, MOCK_UID, &nonce, key, "Laptop", "windows",
        )?;
        let token = fetch(srv, key, &reg.id)?;
        Ok((reg.id, token))
    }

    fn fetch(
        srv: &MockEntitlementServer,
        key: &DeviceKey,
        id: &str,
    ) -> Result<api::TokenReply, ApiError> {
        let b = bearer();
        let nonce = api::challenge(srv, MOCK_BASE, &b)?;
        api::entitlement(srv, MOCK_BASE, &b, MOCK_UID, &nonce, id, key, &build())
    }

    fn state_of(reply: &api::TokenReply, key: &DeviceKey, now: i64) -> LicenseState {
        let keys = KeySet::from_certs(&reply.certs, BUILTIN_ROOTS, now, &[]);
        state_from_token(
            Some(&reply.token),
            &keys,
            MOCK_BASE,
            &key.fingerprint(),
            now,
            0,
            BUILD,
        )
    }

    fn key(n: u8) -> DeviceKey {
        DeviceKey::from_seeds([n; 32], [n.wrapping_add(100); 32])
    }

    #[test]
    fn free_round_trip() {
        let srv = MockEntitlementServer::new(MockMode::Free, NOW);
        let k = key(1);
        let (id, reply) = sign_in(&srv, &k).unwrap();
        assert_eq!(reply.refresh_after, NOW + REFRESH_AFTER_S);
        assert_eq!(state_of(&reply, &k, NOW), LicenseState::free(None));
        assert_eq!(
            api::activate(&srv, MOCK_BASE, &bearer(), &id).unwrap_err(),
            ApiError::NoGrant
        );
    }

    #[test]
    fn pro_round_trip_activate_then_token_has_pro() {
        let srv = MockEntitlementServer::new(MockMode::Pro, NOW);
        let k = key(2);
        let (id, before) = sign_in(&srv, &k).unwrap();
        // Owning Pro is not enough: the device needs a seat.
        assert!(!allows(&state_of(&before, &k, NOW), "pro.phone"));
        assert_eq!(
            api::activate(&srv, MOCK_BASE, &bearer(), &id).unwrap(),
            "grant-pro"
        );
        // Asking again returns the seat it already holds.
        assert_eq!(
            api::activate(&srv, MOCK_BASE, &bearer(), &id).unwrap(),
            "grant-pro"
        );
        assert_eq!(srv.active_seats(), 1);
        let after = fetch(&srv, &k, &id).unwrap();
        let s = state_of(&after, &k, NOW);
        assert!(allows(&s, "pro.phone"));
        assert!(allows(&s, "pro.early"));
        assert!(!allows(&s, "sync.vault"));
        let LicenseState::Active {
            freshness,
            device,
            pro,
            ..
        } = &s
        else {
            panic!("expected Active, got {s:?}");
        };
        assert_eq!(*freshness, Freshness::Fresh);
        assert_eq!(device.fingerprint, k.fingerprint());
        assert_eq!((device.max, device.active), (2, 1));
        assert!(pro.as_ref().unwrap().perpetual);

        // Offline past exp: the perpetual rule keeps Pro for a build inside the cap.
        let later = NOW + TOKEN_LIFETIME_S + 86_400;
        assert!(allows(&state_of(&after, &k, later), "pro.phone"));

        let rows = api::devices(&srv, MOCK_BASE, &bearer()).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pro_grant.as_deref(), Some("grant-pro"));
    }

    #[test]
    fn re_register_returns_the_same_device() {
        let srv = MockEntitlementServer::new(MockMode::Pro, NOW);
        let k = key(3);
        let (first, _) = sign_in(&srv, &k).unwrap();
        let (second, _) = sign_in(&srv, &k).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn a_nonce_is_spent_once() {
        let srv = MockEntitlementServer::new(MockMode::Pro, NOW);
        let k = key(4);
        let (id, _) = sign_in(&srv, &k).unwrap();
        let b = bearer();
        let nonce = api::challenge(&srv, MOCK_BASE, &b).unwrap();
        api::entitlement(&srv, MOCK_BASE, &b, MOCK_UID, &nonce, &id, &k, &build()).unwrap();
        assert_eq!(
            api::entitlement(&srv, MOCK_BASE, &b, MOCK_UID, &nonce, &id, &k, &build()).unwrap_err(),
            ApiError::Unavailable
        );
    }

    #[test]
    fn a_proof_for_another_user_is_refused() {
        let srv = MockEntitlementServer::new(MockMode::Pro, NOW);
        let b = bearer();
        let nonce = api::challenge(&srv, MOCK_BASE, &b).unwrap();
        let err = api::register(
            &srv,
            MOCK_BASE,
            &b,
            "someone-else",
            &nonce,
            &key(5),
            "n",
            "p",
        )
        .unwrap_err();
        assert_eq!(err, ApiError::Unavailable);
    }

    #[test]
    fn no_seat() {
        let srv = MockEntitlementServer::new(MockMode::ProNoSeat, NOW);
        let k = key(6);
        let (id, _) = sign_in(&srv, &k).unwrap();
        let err = api::activate(&srv, MOCK_BASE, &bearer(), &id).unwrap_err();
        assert_eq!(err, ApiError::NoSeat);
        assert_eq!(err.code(), E_NO_SEAT);
    }

    #[test]
    fn transfer_limit() {
        let srv = MockEntitlementServer::new(MockMode::TransferLimit, NOW);
        let k = key(7);
        let (id, _) = sign_in(&srv, &k).unwrap();
        api::activate(&srv, MOCK_BASE, &bearer(), &id).unwrap();
        let err = api::deactivate(&srv, MOCK_BASE, &bearer(), &id).unwrap_err();
        assert_eq!(err.code(), E_TRANSFER_LIMIT);
        assert_eq!(srv.active_seats(), 1);
    }

    #[test]
    fn deactivate_counts_a_transfer() {
        let srv = MockEntitlementServer::new(MockMode::Pro, NOW);
        let k = key(8);
        let (id, _) = sign_in(&srv, &k).unwrap();
        api::activate(&srv, MOCK_BASE, &bearer(), &id).unwrap();
        api::deactivate(&srv, MOCK_BASE, &bearer(), &id).unwrap();
        assert_eq!(srv.transfers(), 1);
        assert_eq!(srv.active_seats(), 0);
        assert_eq!(
            api::deactivate(&srv, MOCK_BASE, &bearer(), &id).unwrap_err(),
            ApiError::NotFound
        );
    }

    #[test]
    fn revoked() {
        let srv = MockEntitlementServer::new(MockMode::Revoked, NOW);
        let err = sign_in(&srv, &key(9)).unwrap_err();
        assert_eq!(err, ApiError::Revoked);
        assert_eq!(err.code(), E_REVOKED);
    }

    #[test]
    fn removed_device_is_revoked() {
        let srv = MockEntitlementServer::new(MockMode::Pro, NOW);
        let k = key(10);
        let (id, _) = sign_in(&srv, &k).unwrap();
        api::remove_device(&srv, MOCK_BASE, &bearer(), &id).unwrap();
        assert_eq!(fetch(&srv, &k, &id).unwrap_err(), ApiError::Revoked);
        let rows = api::devices(&srv, MOCK_BASE, &bearer()).unwrap();
        assert_eq!(rows[0].revoked_at, Some(NOW));
    }

    #[test]
    fn offline() {
        let srv = MockEntitlementServer::new(MockMode::Offline, NOW);
        assert_eq!(sign_in(&srv, &key(11)).unwrap_err(), ApiError::Unavailable);
    }

    #[test]
    fn bad_root_yields_server_key() {
        let srv = MockEntitlementServer::new(MockMode::BadRoot, NOW);
        let k = key(12);
        let (id, _) = sign_in(&srv, &k).unwrap();
        api::activate(&srv, MOCK_BASE, &bearer(), &id).unwrap();
        let reply = fetch(&srv, &k, &id).unwrap();
        assert_eq!(
            state_of(&reply, &k, NOW),
            LicenseState::free(Some(E_SERVER_KEY))
        );
    }

    #[test]
    fn wrong_bearer_is_unauthorized() {
        let srv = MockEntitlementServer::new(MockMode::Pro, NOW);
        let b = Secret::new("other-session-token-xxxxxxxx".to_owned());
        assert_eq!(
            api::challenge(&srv, MOCK_BASE, &b).unwrap_err(),
            ApiError::Unauthorized
        );
    }

    #[test]
    fn keys_endpoint_certifies_under_the_test_root() {
        let srv = MockEntitlementServer::new(MockMode::Pro, NOW);
        let certs = api::keys(&srv, MOCK_BASE, &bearer()).unwrap();
        assert_eq!(KeySet::from_certs(&certs, BUILTIN_ROOTS, NOW, &[]).len(), 1);
    }

    #[test]
    fn injected_now_moves_the_token() {
        let srv = MockEntitlementServer::new(MockMode::Pro, NOW);
        let k = key(13);
        let (id, _) = sign_in(&srv, &k).unwrap();
        srv.set_now(NOW + 1_000);
        assert_eq!(srv.now(), NOW + 1_000);
        let r = fetch(&srv, &k, &id).unwrap();
        assert_eq!(r.refresh_after, NOW + 1_000 + REFRESH_AFTER_S);
    }
}
