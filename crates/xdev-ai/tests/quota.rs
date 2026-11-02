use std::path::Path;

use xdev_ai::{
    AccountStatus, Quota, QuotaState, QuotaWindow, StatusState, classify, login_command, pick,
};

fn windows(values: &[Option<f64>]) -> Vec<QuotaWindow> {
    values
        .iter()
        .enumerate()
        .map(|(i, v)| QuotaWindow {
            key: format!("w{i}"),
            utilization: *v,
            resets_at: None,
        })
        .collect()
}

#[test]
fn classify_edges() {
    let cases = [
        (30, vec![Some(69.0)], QuotaState::Ok),
        (30, vec![Some(70.0)], QuotaState::Reserve),
        (30, vec![Some(99.9)], QuotaState::Reserve),
        (30, vec![Some(100.0)], QuotaState::Full),
        (30, vec![Some(10.0), Some(120.0)], QuotaState::Full),
        (30, vec![None, Some(75.0)], QuotaState::Reserve),
        (0, vec![Some(99.0)], QuotaState::Ok),
        (0, vec![Some(100.0)], QuotaState::Full),
        (90, vec![Some(9.0)], QuotaState::Ok),
        (90, vec![Some(10.0)], QuotaState::Reserve),
        (30, vec![None, None], QuotaState::Unknown),
        (30, vec![], QuotaState::Unknown),
    ];
    for (reserve, values, want) in cases {
        assert_eq!(
            classify(&windows(&values), reserve),
            want,
            "{reserve} {values:?}"
        );
    }
}

fn account(name: &str, state: StatusState, quota: QuotaState, top: f64) -> (AccountStatus, Quota) {
    let status = AccountStatus {
        state,
        email: None,
        plan: None,
        org: None,
    };
    let quota = Quota {
        name: name.to_owned(),
        state: quota,
        reason: None,
        windows: windows(&[Some(top / 2.0), Some(top)]),
    };
    (status, quota)
}

#[test]
fn pick_skips_unusable_and_breaks_ties_by_name() {
    use QuotaState as Q;
    use StatusState as S;
    let quotas = vec![
        account("a-out", S::LoggedOut, Q::Ok, 1.0),
        account("b-reserve", S::LoggedIn, Q::Reserve, 2.0),
        account("c-unknown", S::LoggedIn, Q::Unknown, 0.0),
        account("z-tie", S::LoggedIn, Q::Ok, 40.0),
        account("m-tie", S::LoggedIn, Q::Ok, 40.0),
        account("d-busy", S::LoggedIn, Q::Ok, 60.0),
    ];
    assert_eq!(pick(&quotas).as_deref(), Some("m-tie"));
    assert_eq!(pick(&quotas[..3]), None);
    assert_eq!(pick(&[]), None);
}

#[test]
fn login_command_quotes_for_each_shell() {
    let dir = Path::new("C:\\Users\\Me Too\\it's");
    assert_eq!(
        login_command(dir, true),
        "$env:CLAUDE_CONFIG_DIR='C:\\Users\\Me Too\\it''s'; claude auth login"
    );
    let dir = Path::new("/home/me too/it's");
    assert_eq!(
        login_command(dir, false),
        "CLAUDE_CONFIG_DIR='/home/me too/it'\\''s' claude auth login"
    );
}

#[test]
fn serializes_like_the_ts_contract() {
    let quota = Quota {
        name: "a".into(),
        state: QuotaState::Unknown,
        reason: Some(xdev_ai::Reason::NoCredentials),
        windows: vec![QuotaWindow {
            key: "five_hour".into(),
            utilization: Some(12.5),
            resets_at: Some("2026-11-02T10:00:00Z".into()),
        }],
    };
    let json = serde_json::to_value(&quota).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "name": "a", "state": "unknown", "reason": "no_credentials",
            "windows": [{ "key": "five_hour", "utilization": 12.5, "resetsAt": "2026-11-02T10:00:00Z" }]
        })
    );
    let status = AccountStatus {
        state: StatusState::LoggedOut,
        email: None,
        plan: Some("max".into()),
        org: None,
    };
    assert_eq!(
        serde_json::to_value(&status).unwrap(),
        serde_json::json!({ "state": "logged_out", "email": null, "plan": "max", "org": null })
    );
}
