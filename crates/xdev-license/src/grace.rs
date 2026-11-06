//! The offline rules: what a verified token still grants at `now`.
//!
//! - Before `rfa`: `Fresh`. Until `exp`: `Grace { days_offline }`. Both grant the token's
//!   features.
//! - After `exp`, or with the clock set back more than `CLOCK_TOLERANCE_S` behind the last
//!   time seen (`ClockRollback`): Sync, push and Team drop. Pro stays only under the perpetual
//!   rule: a perpetual grant and a build dated on or before `updates_until` (no date = no cap).
//!   `build_date == 0` (unknown) never meets the perpetual rule, so Pro then needs a token
//!   that has not expired.
//!
//! `plan`, `pro`, `sync_until` and `team` describe the last token; `features` is what works now.

use serde::{Deserialize, Serialize};

use crate::certs::KeySet;
use crate::claims::{CLOCK_TOLERANCE_S, Claims, verify};
use crate::features::{EARLY, SERVER_PRO_FEATURES, is_known};
use crate::jws::VerifyError;
use crate::{E_SERVER_KEY, E_UNAVAILABLE, E_WRONG_DEVICE};

const DAY_S: i64 = 86_400;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(rename = "LicenseFreshness"))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Freshness {
    Fresh,
    /// Past `rfa`, before `exp`: the last refresh failed or the device is offline.
    Grace {
        days_offline: u32,
    },
    Expired,
    ClockRollback,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ProInfo {
    pub grant: String,
    pub perpetual: bool,
    /// Unix seconds; builds dated after it lose Pro once the token expires. Null: no cap.
    pub updates_until: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TeamInfo {
    pub org: String,
    pub role: String,
    pub seat: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    /// This device: `b64url(sha256(pub))[0..22]`.
    pub fingerprint: String,
    /// Pro seats on the grant, and how many are in use.
    pub max: u32,
    pub active: u32,
}

/// What the frontend sees. It never holds the token.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LicenseState {
    /// `notice` is one of the `license_*` codes, or null.
    Free { notice: Option<String> },
    Active {
        plan: Vec<String>,
        features: Vec<String>,
        freshness: Freshness,
        pro: Option<ProInfo>,
        sync_until: Option<i64>,
        team: Option<TeamInfo>,
        device: DeviceInfo,
    },
}

impl LicenseState {
    pub fn free(notice: Option<&str>) -> LicenseState {
        LicenseState::Free {
            notice: notice.map(str::to_owned),
        }
    }
}

/// The perpetual rule, independent of the clock.
fn pro_survives(c: &Claims, build_date: i64) -> bool {
    match &c.pro {
        Some(p) if p.perpetual && build_date > 0 => p.updates_until.is_none_or(|u| build_date <= u),
        _ => false,
    }
}

fn with_early(mut features: Vec<String>) -> Vec<String> {
    if features
        .iter()
        .any(|f| SERVER_PRO_FEATURES.contains(&f.as_str()))
        && !features.iter().any(|f| f == EARLY)
    {
        features.push(EARLY.to_owned());
    }
    features
}

/// `last_seen` is the latest time this device has seen (cache `last_seen_time`), 0 if none.
pub fn evaluate(
    claims: Option<&Claims>,
    now: i64,
    last_seen: i64,
    build_date: i64,
) -> LicenseState {
    let Some(c) = claims else {
        return LicenseState::free(None);
    };
    if c.plan.iter().all(|p| p == "free") {
        return LicenseState::free(None);
    }
    let freshness = if last_seen - now > CLOCK_TOLERANCE_S {
        Freshness::ClockRollback
    } else if now < c.rfa {
        Freshness::Fresh
    } else if now < c.exp {
        let days = (now - c.iat).max(0) / DAY_S;
        Freshness::Grace {
            days_offline: u32::try_from(days).unwrap_or(u32::MAX),
        }
    } else {
        Freshness::Expired
    };
    let known = c.features.iter().filter(|f| is_known(f)).cloned();
    let features: Vec<String> = match freshness {
        Freshness::Fresh | Freshness::Grace { .. } => known.collect(),
        Freshness::Expired | Freshness::ClockRollback if pro_survives(c, build_date) => known
            .filter(|f| SERVER_PRO_FEATURES.contains(&f.as_str()))
            .collect(),
        Freshness::Expired | Freshness::ClockRollback => Vec::new(),
    };
    LicenseState::Active {
        plan: c.plan.clone(),
        features: with_early(features),
        freshness,
        pro: c.pro.as_ref().map(|p| ProInfo {
            grant: p.grant.clone(),
            perpetual: p.perpetual,
            updates_until: p.updates_until,
        }),
        sync_until: c.sync.as_ref().and_then(|s| s.until),
        team: c.team.as_ref().map(|t| TeamInfo {
            org: t.org.clone(),
            role: t.role.clone(),
            seat: t.seat,
        }),
        device: DeviceInfo {
            fingerprint: c.dev.clone(),
            max: c.devices.max,
            active: c.devices.active,
        },
    }
}

/// Verify, then evaluate. A token that does not verify is Free with a notice.
pub fn state_from_token(
    token: Option<&str>,
    keys: &KeySet,
    iss: &str,
    dev: &str,
    now: i64,
    last_seen: i64,
    build_date: i64,
) -> LicenseState {
    let Some(token) = token else {
        return LicenseState::free(None);
    };
    match verify(token, keys, iss, dev, now) {
        Ok(c) => evaluate(Some(&c), now, last_seen, build_date),
        Err(VerifyError::WrongDevice) => LicenseState::free(Some(E_WRONG_DEVICE)),
        Err(
            VerifyError::UnknownKid
            | VerifyError::RevokedKid
            | VerifyError::BadSignature
            | VerifyError::BadAlg,
        ) => LicenseState::free(Some(E_SERVER_KEY)),
        Err(
            VerifyError::Malformed
            | VerifyError::WrongIss
            | VerifyError::WrongAud
            | VerifyError::NotYetValid,
        ) => LicenseState::free(Some(E_UNAVAILABLE)),
    }
}

/// Build date in unix seconds: `SOURCE_DATE_EPOCH`, else the commit time, else 0 (unknown).
pub fn parse_build_date(source_date_epoch: Option<&str>, commit_time: Option<&str>) -> i64 {
    [source_date_epoch, commit_time]
        .into_iter()
        .flatten()
        .find_map(|s| s.trim().parse::<i64>().ok().filter(|v| *v > 0))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claims::{DevicesClaim, SyncClaim, TeamClaim};
    use crate::jws::tests::golden;

    const IAT: i64 = 1_793_836_800;
    const RFA: i64 = IAT + DAY_S;
    const EXP: i64 = IAT + 14 * DAY_S;
    const UPDATES_UNTIL: i64 = 1_825_372_800;

    fn claims() -> Claims {
        serde_json::from_value(golden().claims).unwrap()
    }

    fn features(s: &LicenseState) -> Vec<String> {
        match s {
            LicenseState::Active { features, .. } => features.clone(),
            LicenseState::Free { .. } => Vec::new(),
        }
    }

    fn freshness(s: &LicenseState) -> Option<Freshness> {
        match s {
            LicenseState::Active { freshness, .. } => Some(freshness.clone()),
            LicenseState::Free { .. } => None,
        }
    }

    fn has(s: &LicenseState, f: &str) -> bool {
        features(s).iter().any(|x| x == f)
    }

    #[test]
    fn no_token_is_free() {
        assert_eq!(evaluate(None, IAT, 0, IAT), LicenseState::free(None));
    }

    #[test]
    fn before_rfa_is_fresh() {
        let s = evaluate(Some(&claims()), IAT + 60, IAT, IAT);
        assert_eq!(freshness(&s), Some(Freshness::Fresh));
        assert!(has(&s, "pro.phone"));
        assert!(has(&s, "sync.vault"));
        assert!(has(&s, "push.phone"));
        assert!(has(&s, "pro.early"));
    }

    #[test]
    fn between_rfa_and_exp_is_grace_with_day_count() {
        let s = evaluate(Some(&claims()), IAT + 3 * DAY_S + 5, IAT, IAT);
        assert_eq!(freshness(&s), Some(Freshness::Grace { days_offline: 3 }));
        assert!(has(&s, "sync.vault"));
        let at_rfa = evaluate(Some(&claims()), RFA, IAT, IAT);
        assert_eq!(
            freshness(&at_rfa),
            Some(Freshness::Grace { days_offline: 1 })
        );
    }

    #[test]
    fn after_exp_drops_sync_push_team() {
        let mut c = claims();
        c.plan.push("team".into());
        c.features.push("team.workspace".into());
        c.team = Some(TeamClaim {
            org: "org-1".into(),
            role: "member".into(),
            seat: true,
        });
        let s = evaluate(Some(&c), EXP, EXP - 10, IAT);
        assert_eq!(freshness(&s), Some(Freshness::Expired));
        assert!(!has(&s, "sync.vault"));
        assert!(!has(&s, "push.phone"));
        assert!(!has(&s, "team.workspace"));
    }

    #[test]
    fn clock_behind_last_seen_by_2h_is_clock_rollback() {
        let now = IAT + 3_600;
        let s = evaluate(Some(&claims()), now, now + 2 * 3_600, IAT);
        assert_eq!(freshness(&s), Some(Freshness::ClockRollback));
        assert!(!has(&s, "sync.vault"));
        // The perpetual rule does not read the clock, so Pro stays.
        assert!(has(&s, "pro.phone"));
    }

    #[test]
    fn clock_behind_by_30_min_is_tolerated() {
        let now = IAT + 3_600;
        let s = evaluate(Some(&claims()), now, now + 30 * 60, IAT);
        assert_eq!(freshness(&s), Some(Freshness::Fresh));
        assert!(has(&s, "sync.vault"));
    }

    #[test]
    fn pro_perpetual_survives_exp_when_build_date_le_updates_until() {
        for build in [IAT, UPDATES_UNTIL] {
            let s = evaluate(Some(&claims()), EXP + 400 * DAY_S, EXP, build);
            assert_eq!(freshness(&s), Some(Freshness::Expired));
            assert!(has(&s, "pro.phone"), "build {build}");
            assert!(has(&s, "pro.layouts"));
            assert!(has(&s, "pro.early"));
            assert!(!has(&s, "sync.vault"));
        }
    }

    #[test]
    fn pro_perpetual_lost_when_build_newer_than_updates_until() {
        let s = evaluate(Some(&claims()), EXP + DAY_S, EXP, UPDATES_UNTIL + 1);
        assert_eq!(freshness(&s), Some(Freshness::Expired));
        assert!(features(&s).is_empty());
    }

    #[test]
    fn pro_without_update_cap_survives_any_build() {
        let mut c = claims();
        c.pro.as_mut().unwrap().updates_until = None;
        let s = evaluate(Some(&c), EXP + DAY_S, EXP, UPDATES_UNTIL * 2);
        assert!(has(&s, "pro.phone"));
    }

    #[test]
    fn pro_subscription_is_lost_after_exp() {
        let mut c = claims();
        c.pro.as_mut().unwrap().perpetual = false;
        let s = evaluate(Some(&c), EXP, EXP, IAT);
        assert!(features(&s).is_empty());
    }

    #[test]
    fn build_date_0_needs_fresh_token_for_pro() {
        let before = evaluate(Some(&claims()), RFA + 60, IAT, 0);
        assert!(has(&before, "pro.phone"));
        let after = evaluate(Some(&claims()), EXP, EXP, 0);
        assert_eq!(freshness(&after), Some(Freshness::Expired));
        assert!(!has(&after, "pro.phone"));
    }

    #[test]
    fn wrong_device_fingerprint_is_free_with_notice() {
        let g = golden();
        let keys = KeySet::from_keys(&[(g.kid.as_str(), g.public)]);
        let iss = "https://id.xdev.asia";
        let ok = state_from_token(
            Some(&g.token),
            &keys,
            iss,
            "GOLDENDEVICEFINGERPRINT",
            IAT,
            0,
            IAT,
        );
        assert!(matches!(ok, LicenseState::Active { .. }));
        let other = state_from_token(Some(&g.token), &keys, iss, "ANOTHERDEVICE", IAT, 0, IAT);
        assert_eq!(other, LicenseState::free(Some(E_WRONG_DEVICE)));
    }

    #[test]
    fn unverifiable_token_is_free_with_server_key_notice() {
        let g = golden();
        let s = state_from_token(
            Some(&g.token),
            &KeySet::default(),
            "https://id.xdev.asia",
            "GOLDENDEVICEFINGERPRINT",
            IAT,
            0,
            IAT,
        );
        assert_eq!(s, LicenseState::free(Some(E_SERVER_KEY)));
    }

    #[test]
    fn matches_golden_vector_ent_v1_claims() {
        let s = evaluate(Some(&claims()), IAT, 0, IAT);
        let LicenseState::Active {
            plan,
            features,
            freshness,
            pro,
            sync_until,
            team,
            device,
        } = s
        else {
            panic!("golden claims are active");
        };
        assert_eq!(plan, vec!["pro", "sync"]);
        assert_eq!(
            features,
            vec![
                "pro.phone",
                "pro.usage_history",
                "pro.session_replay",
                "pro.layouts",
                "sync.vault",
                "push.phone",
                "pro.early",
            ]
        );
        assert_eq!(freshness, Freshness::Fresh);
        assert_eq!(
            pro,
            Some(ProInfo {
                grant: "grant-golden-1".into(),
                perpetual: true,
                updates_until: Some(UPDATES_UNTIL),
            })
        );
        assert_eq!(sync_until, Some(UPDATES_UNTIL));
        assert_eq!(team, None);
        assert_eq!(
            device,
            DeviceInfo {
                fingerprint: "GOLDENDEVICEFINGERPRINT".into(),
                max: 1,
                active: 1,
            }
        );
    }

    #[test]
    fn free_plan_token_is_free() {
        let c = Claims {
            plan: vec!["free".into()],
            features: Vec::new(),
            pro: None,
            sync: None,
            team: None,
            devices: DevicesClaim { max: 0, active: 0 },
            ..claims()
        };
        assert_eq!(evaluate(Some(&c), IAT, 0, IAT), LicenseState::free(None));
    }

    #[test]
    fn sync_only_has_no_pro_after_exp() {
        let c = Claims {
            plan: vec!["sync".into()],
            pro: None,
            sync: Some(SyncClaim {
                until: None,
                quota_bytes: 1,
            }),
            ..claims()
        };
        assert!(has(&evaluate(Some(&c), IAT, 0, IAT), "pro.phone"));
        assert!(features(&evaluate(Some(&c), EXP, 0, IAT)).is_empty());
    }

    #[test]
    fn state_serializes_for_the_frontend() {
        let s = evaluate(Some(&claims()), IAT + 2 * DAY_S, 0, IAT);
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["state"], "active");
        assert_eq!(v["freshness"]["kind"], "grace");
        assert_eq!(v["freshness"]["daysOffline"], 2);
        assert_eq!(v["syncUntil"], UPDATES_UNTIL);
        assert_eq!(v["pro"]["updatesUntil"], UPDATES_UNTIL);
        let free = serde_json::to_value(LicenseState::free(Some(E_SERVER_KEY))).unwrap();
        assert_eq!(
            free,
            serde_json::json!({"state": "free", "notice": "license_server_key"})
        );
    }

    #[test]
    fn build_date_parses_source_date_epoch() {
        assert_eq!(
            parse_build_date(Some("1793836800"), Some("5")),
            1_793_836_800
        );
        assert_eq!(
            parse_build_date(Some(" "), Some("1793836801\n")),
            1_793_836_801
        );
    }

    #[test]
    fn missing_date_yields_0() {
        assert_eq!(parse_build_date(None, None), 0);
        assert_eq!(parse_build_date(Some("x"), Some("-4")), 0);
    }
}
