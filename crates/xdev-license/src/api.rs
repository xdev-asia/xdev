//! The entitlement service calls (`/v1/*` on the xDev ID base), over `xdev_id::Transport`.
//! Every call takes the desktop session token as the bearer. The device proof signs
//! `purpose \n nonce \n uid`, so the caller passes the signed-in user's id (`sub`).

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use xdev_id::{Method, Request, Response, Secret, Transport};

use crate::keystore::{DEVICE_PROOF, DeviceKey, ENT_PROOF, proof_message};
use crate::{E_NO_SEAT, E_REVOKED, E_TRANSFER_LIMIT, E_UNAVAILABLE, b64};

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ApiError {
    /// 401: the session token is no longer valid; the caller signs out.
    #[error("unauthorized")]
    Unauthorized,
    /// Offline, a 5xx, or a reply that does not parse.
    #[error("license_unavailable")]
    Unavailable,
    /// 403 `device_revoked`: the account removed this device.
    #[error("license_device_revoked")]
    Revoked,
    /// 409 `no_free_seat` (lane D: `no_seat`): every Pro seat is on other devices.
    #[error("license_no_seat")]
    NoSeat,
    /// 429 `transfer_limit`.
    #[error("license_transfer_limit")]
    TransferLimit,
    /// 404 `no_grant`: the account has no active Pro grant.
    #[error("no_grant")]
    NoGrant,
    /// 404 `device_unknown`: the service has no such device for this user (C1). The caller
    /// drops its device id and registers again; the account did not revoke anything.
    #[error("device_unknown")]
    DeviceUnknown,
    /// 404 `not_found`: no such device, or no activation to end.
    #[error("not_found")]
    NotFound,
    /// 409 `device_limit` or `device_conflict` at registration.
    #[error("device_rejected")]
    DeviceRejected,
}

/// Lane D's name.
pub type CallError = ApiError;

impl ApiError {
    /// The `license_*` code the frontend sees. Errors without their own code read as
    /// `license_unavailable`; the desktop glue handles `Unauthorized` and `NoGrant` itself.
    pub fn code(self) -> &'static str {
        match self {
            ApiError::Revoked => E_REVOKED,
            ApiError::NoSeat => E_NO_SEAT,
            ApiError::TransferLimit => E_TRANSFER_LIMIT,
            ApiError::Unauthorized
            | ApiError::Unavailable
            | ApiError::NoGrant
            | ApiError::NotFound
            | ApiError::DeviceUnknown
            | ApiError::DeviceRejected => E_UNAVAILABLE,
        }
    }
}

/// Sent with each entitlement request. The service does not read it yet.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuildInfo {
    pub version: String,
    /// Unix seconds, 0 if unknown.
    pub date: i64,
}

#[derive(Clone, PartialEq, Eq)]
pub struct TokenReply {
    pub token: String,
    pub certs: Vec<String>,
    pub refresh_after: i64,
}

/// Never prints the token.
impl fmt::Debug for TokenReply {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TokenReply")
            .field("certs", &self.certs.len())
            .field("refresh_after", &self.refresh_after)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Registered {
    pub id: String,
    pub fingerprint: String,
}

/// One device on the account (`GET /v1/devices`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DeviceRow {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub fingerprint: String,
    pub created_at: i64,
    pub last_seen_at: Option<i64>,
    pub revoked_at: Option<i64>,
    /// The Pro grant this device holds a seat on, or null.
    pub pro_grant: Option<String>,
}

/// The service's snake_case row.
#[derive(Deserialize)]
struct WireDevice {
    id: String,
    name: String,
    platform: String,
    fingerprint: String,
    created_at: i64,
    last_seen_at: Option<i64>,
    revoked_at: Option<i64>,
    pro_grant: Option<String>,
}

fn call(
    http: &dyn Transport,
    method: Method,
    url: String,
    bearer: &Secret,
    body: Option<Value>,
) -> Result<Response, ApiError> {
    let req = Request {
        method,
        url,
        bearer: Some(bearer.clone()),
        json: body.map(|b| Secret::new(b.to_string())),
    };
    http.send(&req).map_err(|_| ApiError::Unavailable)
}

fn json_of(res: &Response) -> Option<Value> {
    serde_json::from_slice(&res.body).ok()
}

fn error_name(res: &Response) -> Option<String> {
    json_of(res)?.get("error")?.as_str().map(str::to_owned)
}

/// The status mapping shared by every call.
fn fail(res: &Response) -> ApiError {
    let name = error_name(res);
    match (res.status, name.as_deref()) {
        (401, _) => ApiError::Unauthorized,
        (403, Some("device_revoked")) => ApiError::Revoked,
        (409, Some("no_seat" | "no_free_seat" | "seats_full")) => ApiError::NoSeat,
        (409, Some("device_limit" | "device_conflict")) => ApiError::DeviceRejected,
        (429, Some("transfer_limit")) => ApiError::TransferLimit,
        (404, Some("no_grant")) => ApiError::NoGrant,
        (404, Some("device_unknown")) => ApiError::DeviceUnknown,
        (404, Some("not_found")) => ApiError::NotFound,
        _ => ApiError::Unavailable,
    }
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key)?.as_str().map(str::to_owned)
}

/// `POST /v1/devices/challenge`: a one-time nonce for the next proof.
pub fn challenge(http: &dyn Transport, base: &str, bearer: &Secret) -> Result<String, ApiError> {
    let res = call(
        http,
        Method::Post,
        format!("{base}/v1/devices/challenge"),
        bearer,
        Some(json!({})),
    )?;
    if res.status != 200 {
        return Err(fail(&res));
    }
    json_of(&res)
        .and_then(|v| text(&v, "nonce"))
        .filter(|n| n.len() == 43)
        .ok_or(ApiError::Unavailable)
}

/// `POST /v1/devices`: registers (or re-registers) this device's keys.
#[allow(clippy::too_many_arguments)]
pub fn register(
    http: &dyn Transport,
    base: &str,
    bearer: &Secret,
    uid: &str,
    nonce: &str,
    key: &DeviceKey,
    name: &str,
    platform: &str,
) -> Result<Registered, ApiError> {
    let sig = key.sign(proof_message(DEVICE_PROOF, nonce, uid).as_bytes());
    let body = json!({
        "pub": key.public_b64(),
        "box_pub": key.box_public_b64(),
        "name": name,
        "platform": platform,
        "nonce": nonce,
        "sig": b64::encode(&sig),
    });
    let res = call(
        http,
        Method::Post,
        format!("{base}/v1/devices"),
        bearer,
        Some(body),
    )?;
    if res.status != 200 && res.status != 201 {
        return Err(fail(&res));
    }
    let v = json_of(&res).ok_or(ApiError::Unavailable)?;
    match (text(&v, "id"), text(&v, "fingerprint")) {
        (Some(id), Some(fingerprint)) if fingerprint == key.fingerprint() => {
            Ok(Registered { id, fingerprint })
        }
        _ => Err(ApiError::Unavailable),
    }
}

/// `POST /v1/devices/challenge` then `POST /v1/devices`.
pub fn register_fresh(
    http: &dyn Transport,
    base: &str,
    bearer: &Secret,
    uid: &str,
    key: &DeviceKey,
    name: &str,
    platform: &str,
) -> Result<Registered, ApiError> {
    let nonce = challenge(http, base, bearer)?;
    register(http, base, bearer, uid, &nonce, key, name, platform)
}

/// `POST /v1/devices/challenge` then `POST /v1/entitlement`.
pub fn entitlement_fresh(
    http: &dyn Transport,
    base: &str,
    bearer: &Secret,
    uid: &str,
    device_id: &str,
    key: &DeviceKey,
    build: &BuildInfo,
) -> Result<TokenReply, ApiError> {
    let nonce = challenge(http, base, bearer)?;
    entitlement(http, base, bearer, uid, &nonce, device_id, key, build)
}

/// `POST /v1/entitlement`: a fresh token for this device.
#[allow(clippy::too_many_arguments)]
pub fn entitlement(
    http: &dyn Transport,
    base: &str,
    bearer: &Secret,
    uid: &str,
    nonce: &str,
    device_id: &str,
    key: &DeviceKey,
    build: &BuildInfo,
) -> Result<TokenReply, ApiError> {
    let sig = key.sign(proof_message(ENT_PROOF, nonce, uid).as_bytes());
    let body = json!({
        "device_id": device_id,
        "nonce": nonce,
        "sig": b64::encode(&sig),
        "build": build,
    });
    let res = call(
        http,
        Method::Post,
        format!("{base}/v1/entitlement"),
        bearer,
        Some(body),
    )?;
    if res.status != 200 {
        return Err(fail(&res));
    }
    let v = json_of(&res).ok_or(ApiError::Unavailable)?;
    let token = text(&v, "token").ok_or(ApiError::Unavailable)?;
    let certs = v
        .get("certs")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|c| c.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let refresh_after = v
        .get("refresh_after")
        .and_then(Value::as_i64)
        .ok_or(ApiError::Unavailable)?;
    Ok(TokenReply {
        token,
        certs,
        refresh_after,
    })
}

/// `POST /v1/activations`: puts this device on a free Pro seat. Returns the grant id; a
/// device that already holds a seat gets its grant back.
pub fn activate(
    http: &dyn Transport,
    base: &str,
    bearer: &Secret,
    device_id: &str,
) -> Result<String, ApiError> {
    let res = call(
        http,
        Method::Post,
        format!("{base}/v1/activations"),
        bearer,
        Some(json!({ "device_id": device_id })),
    )?;
    if res.status != 200 && res.status != 201 {
        return Err(fail(&res));
    }
    json_of(&res)
        .and_then(|v| text(&v, "grant_id"))
        .ok_or(ApiError::Unavailable)
}

/// `DELETE /v1/activations/:device_id`: frees the device's Pro seat (counts as a transfer).
pub fn deactivate(
    http: &dyn Transport,
    base: &str,
    bearer: &Secret,
    device_id: &str,
) -> Result<(), ApiError> {
    let res = call(
        http,
        Method::Delete,
        format!("{base}/v1/activations/{}", path_segment(device_id)?),
        bearer,
        None,
    )?;
    if res.status == 204 || res.status == 200 {
        Ok(())
    } else {
        Err(fail(&res))
    }
}

/// Addition to lane D: `GET /v1/devices`, every device on the account.
pub fn devices(
    http: &dyn Transport,
    base: &str,
    bearer: &Secret,
) -> Result<Vec<DeviceRow>, ApiError> {
    let res = call(
        http,
        Method::Get,
        format!("{base}/v1/devices"),
        bearer,
        None,
    )?;
    if res.status != 200 {
        return Err(fail(&res));
    }
    let v = json_of(&res).ok_or(ApiError::Unavailable)?;
    let rows: Vec<WireDevice> =
        serde_json::from_value(v.get("devices").cloned().unwrap_or(Value::Null))
            .map_err(|_| ApiError::Unavailable)?;
    Ok(rows
        .into_iter()
        .map(|d| DeviceRow {
            id: d.id,
            name: d.name,
            platform: d.platform,
            fingerprint: d.fingerprint,
            created_at: d.created_at,
            last_seen_at: d.last_seen_at,
            revoked_at: d.revoked_at,
            pro_grant: d.pro_grant,
        })
        .collect())
}

/// Addition to lane D: `DELETE /v1/devices/:id`. Revokes the device and frees its seat.
pub fn remove_device(
    http: &dyn Transport,
    base: &str,
    bearer: &Secret,
    id: &str,
) -> Result<(), ApiError> {
    let res = call(
        http,
        Method::Delete,
        format!("{base}/v1/devices/{}", path_segment(id)?),
        bearer,
        None,
    )?;
    if res.status == 204 || res.status == 200 {
        Ok(())
    } else {
        Err(fail(&res))
    }
}

/// `GET /v1/keys`: the current signing certs, for a token cached without them.
pub fn keys(http: &dyn Transport, base: &str, bearer: &Secret) -> Result<Vec<String>, ApiError> {
    let res = call(http, Method::Get, format!("{base}/v1/keys"), bearer, None)?;
    if res.status != 200 {
        return Err(fail(&res));
    }
    let v = json_of(&res).ok_or(ApiError::Unavailable)?;
    v.get("certs")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|c| c.as_str().map(str::to_owned))
                .collect()
        })
        .ok_or(ApiError::Unavailable)
}

/// Ids are UUIDs; anything that would change the path is refused.
fn path_segment(id: &str) -> Result<&str, ApiError> {
    if !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        Ok(id)
    } else {
        Err(ApiError::NotFound)
    }
}

#[cfg(test)]
mod tests {
    use ed25519_dalek::{Signature, VerifyingKey};
    use xdev_id::{FakeTransport, Offline};

    use super::*;

    const BASE: &str = "https://id.example.test";
    const UID: &str = "user-1";

    fn bearer() -> Secret {
        Secret::new("session-token-abcdefghijklmnop".to_owned())
    }

    fn key() -> DeviceKey {
        DeviceKey::from_seeds([3u8; 32], [4u8; 32])
    }

    fn build() -> BuildInfo {
        BuildInfo {
            version: "1.0.0".into(),
            date: 1,
        }
    }

    fn nonce() -> String {
        "N".repeat(43)
    }

    fn body_of(req: &Request) -> Value {
        serde_json::from_str(req.json.as_ref().unwrap().expose()).unwrap()
    }

    fn verify_proof(purpose: &str, body: &Value, k: &DeviceKey) {
        let sig = b64::decode(body["sig"].as_str().unwrap()).unwrap();
        let sig = Signature::from_slice(&sig).unwrap();
        let msg = proof_message(purpose, body["nonce"].as_str().unwrap(), UID);
        VerifyingKey::from_bytes(&k.public())
            .unwrap()
            .verify_strict(msg.as_bytes(), &sig)
            .unwrap();
    }

    #[test]
    fn register_sends_box_pub_and_signed_nonce() {
        let k = key();
        let reply = format!(r#"{{"id":"dev-1","fingerprint":"{}"}}"#, k.fingerprint());
        let t = FakeTransport::new(vec![Ok(Response::json(200, &reply))]);
        let r = register(&t, BASE, &bearer(), UID, &nonce(), &k, "Laptop", "windows").unwrap();
        assert_eq!(r.id, "dev-1");
        let reqs = t.requests();
        assert_eq!(reqs[0].method, Method::Post);
        assert_eq!(reqs[0].url, format!("{BASE}/v1/devices"));
        let body = body_of(&reqs[0]);
        assert_eq!(body["pub"], k.public_b64());
        assert_eq!(body["box_pub"], k.box_public_b64());
        assert_eq!(body["name"], "Laptop");
        assert_eq!(body["platform"], "windows");
        assert_eq!(body["nonce"], nonce());
        verify_proof(DEVICE_PROOF, &body, &k);
    }

    #[test]
    fn register_rejects_a_fingerprint_for_another_key() {
        let t = FakeTransport::new(vec![Ok(Response::json(
            200,
            r#"{"id":"dev-1","fingerprint":"AAAAAAAAAAAAAAAAAAAAAA"}"#,
        ))]);
        let err = register(&t, BASE, &bearer(), UID, &nonce(), &key(), "n", "p").unwrap_err();
        assert_eq!(err, ApiError::Unavailable);
    }

    #[test]
    fn entitlement_signs_with_the_ent_purpose() {
        let k = key();
        let t = FakeTransport::new(vec![Ok(Response::json(
            200,
            r#"{"token":"a.b.c","certs":["x.y.z"],"refresh_after":123}"#,
        ))]);
        let build = BuildInfo {
            version: "1.2.3".into(),
            date: 42,
        };
        let r = entitlement(&t, BASE, &bearer(), UID, &nonce(), "dev-1", &k, &build).unwrap();
        assert_eq!(r.token, "a.b.c");
        assert_eq!(r.certs, vec!["x.y.z".to_owned()]);
        assert_eq!(r.refresh_after, 123);
        assert!(!format!("{r:?}").contains("a.b.c"));
        let body = body_of(&t.requests()[0]);
        assert_eq!(body["device_id"], "dev-1");
        assert_eq!(body["build"]["version"], "1.2.3");
        verify_proof(ENT_PROOF, &body, &k);
    }

    #[test]
    fn entitlement_404_device_unknown_is_not_revoked() {
        let t = FakeTransport::new(vec![Ok(Response::json(
            404,
            r#"{"error":"device_unknown"}"#,
        ))]);
        let err = entitlement(
            &t,
            BASE,
            &bearer(),
            UID,
            &nonce(),
            "dev-1",
            &key(),
            &build(),
        )
        .unwrap_err();
        assert_eq!(err, ApiError::DeviceUnknown);
        assert_eq!(err.code(), E_UNAVAILABLE);
        let t = FakeTransport::new(vec![Ok(Response::json(
            404,
            r#"{"error":"device_unknown"}"#,
        ))]);
        assert_eq!(
            activate(&t, BASE, &bearer(), "dev-1").unwrap_err(),
            ApiError::DeviceUnknown
        );
    }

    #[test]
    fn entitlement_403_maps_to_revoked() {
        let t = FakeTransport::new(vec![Ok(Response::json(
            403,
            r#"{"error":"device_revoked"}"#,
        ))]);
        let build = BuildInfo {
            version: "1".into(),
            date: 0,
        };
        let err = entitlement(&t, BASE, &bearer(), UID, &nonce(), "d", &key(), &build).unwrap_err();
        assert_eq!(err, ApiError::Revoked);
        assert_eq!(err.code(), "license_device_revoked");
    }

    #[test]
    fn activate_409_maps_to_no_seat() {
        let t = FakeTransport::new(vec![
            Ok(Response::json(409, r#"{"error":"no_free_seat"}"#)),
            Ok(Response::json(409, r#"{"error":"no_seat"}"#)),
            Ok(Response::json(404, r#"{"error":"no_grant"}"#)),
            Ok(Response::json(201, r#"{"grant_id":"g-1"}"#)),
        ]);
        let b = bearer();
        assert_eq!(activate(&t, BASE, &b, "d").unwrap_err().code(), E_NO_SEAT);
        assert_eq!(activate(&t, BASE, &b, "d").unwrap_err(), ApiError::NoSeat);
        assert_eq!(activate(&t, BASE, &b, "d").unwrap_err(), ApiError::NoGrant);
        assert_eq!(activate(&t, BASE, &b, "d").unwrap(), "g-1");
        assert_eq!(body_of(&t.requests()[0])["device_id"], "d");
    }

    #[test]
    fn deactivate_maps_transfer_limit_and_uses_delete() {
        let t = FakeTransport::new(vec![
            Ok(Response::json(
                429,
                r#"{"error":"transfer_limit","limit":3}"#,
            )),
            Ok(Response {
                status: 204,
                content_type: None,
                body: Vec::new(),
            }),
        ]);
        let b = bearer();
        assert_eq!(
            deactivate(&t, BASE, &b, "dev-1").unwrap_err().code(),
            E_TRANSFER_LIMIT
        );
        deactivate(&t, BASE, &b, "dev-1").unwrap();
        let reqs = t.requests();
        assert_eq!(reqs[1].method, Method::Delete);
        assert_eq!(reqs[1].url, format!("{BASE}/v1/activations/dev-1"));
        assert!(reqs[1].json.is_none());
        // An id that would change the path never leaves the process.
        assert_eq!(
            deactivate(&t, BASE, &b, "../keys").unwrap_err(),
            ApiError::NotFound
        );
        assert_eq!(t.requests().len(), 2);
    }

    #[test]
    fn devices_and_remove_device() {
        let t = FakeTransport::new(vec![
            Ok(Response::json(
                200,
                r#"{"devices":[{"id":"d1","name":"Laptop","platform":"macos","fingerprint":"fp","created_at":1,"last_seen_at":2,"revoked_at":null,"pro_grant":"g"}]}"#,
            )),
            Ok(Response::json(404, r#"{"error":"not_found"}"#)),
        ]);
        let b = bearer();
        let rows = devices(&t, BASE, &b).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pro_grant.as_deref(), Some("g"));
        assert_eq!(
            serde_json::to_value(&rows[0]).unwrap()["lastSeenAt"],
            serde_json::json!(2)
        );
        assert_eq!(
            remove_device(&t, BASE, &b, "d1").unwrap_err(),
            ApiError::NotFound
        );
        let reqs = t.requests();
        assert_eq!(reqs[0].method, Method::Get);
        assert_eq!(reqs[1].method, Method::Delete);
        assert_eq!(reqs[1].url, format!("{BASE}/v1/devices/d1"));
    }

    #[test]
    fn offline_and_401_and_garbage() {
        let t = FakeTransport::new(vec![
            Err(Offline),
            Ok(Response::json(401, r#"{"error":"unauthorized"}"#)),
            Ok(Response::json(200, "not json")),
            Ok(Response::json(500, "{}")),
        ]);
        let b = bearer();
        assert_eq!(challenge(&t, BASE, &b).unwrap_err(), ApiError::Unavailable);
        assert_eq!(challenge(&t, BASE, &b).unwrap_err(), ApiError::Unauthorized);
        assert_eq!(challenge(&t, BASE, &b).unwrap_err(), ApiError::Unavailable);
        assert_eq!(keys(&t, BASE, &b).unwrap_err().code(), E_UNAVAILABLE);
    }

    #[test]
    fn bearer_never_in_request_debug() {
        let t = FakeTransport::new(vec![Ok(Response::json(
            200,
            &format!(r#"{{"nonce":"{}"}}"#, nonce()),
        ))]);
        assert_eq!(challenge(&t, BASE, &bearer()).unwrap(), nonce());
        let req = &t.requests()[0];
        assert_eq!(req.bearer.as_ref().unwrap().expose(), bearer().expose());
        let text = format!("{req:?}");
        assert!(!text.contains(bearer().expose()));
        assert!(text.contains("/v1/devices/challenge"));
    }
}
