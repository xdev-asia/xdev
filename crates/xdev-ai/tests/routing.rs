use std::fs;

use tempfile::TempDir;

use xdev_ai::{
    AiError, Policy, Provider, Quota, QuotaState, QuotaWindow, Reason, Registry, Routing,
};

fn registry(data: &TempDir) -> Registry {
    let mut reg = Registry::load(data.path()).unwrap();
    for (name, provider) in [
        ("work", Provider::Claude),
        ("home", Provider::Claude),
        ("spare", Provider::Claude),
        ("gpt", Provider::Codex),
    ] {
        reg.add(name, provider, data.path().join(name)).unwrap();
    }
    reg.activate(Provider::Claude, Some("work")).unwrap();
    reg
}

fn used(name: &str, percent: f64) -> Quota {
    Quota {
        name: name.into(),
        state: QuotaState::Ok,
        reason: None,
        windows: vec![QuotaWindow {
            key: "five_hour".into(),
            utilization: Some(percent),
            resets_at: None,
        }],
        as_of: None,
    }
}

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|n| (*n).to_owned()).collect()
}

#[test]
fn defaults_are_manual_with_alerts_at_80_and_95() {
    let r = Routing::new(Provider::Codex);
    assert_eq!(r.policy, Policy::Manual);
    assert!(r.pool.is_empty() && r.priority.is_empty());
    assert_eq!(r.thresholds, [80, 95]);
    assert!(!r.auto_switch);
    assert_eq!(r.switch_at, 95);
}

#[test]
fn routing_round_trips_and_is_sorted() {
    let data = TempDir::new().unwrap();
    let mut reg = registry(&data);
    let routing = Routing {
        policy: Policy::Priority,
        pool: names(&["spare", "home"]),
        priority: names(&["home"]),
        thresholds: vec![95, 50, 95],
        auto_switch: true,
        switch_at: 90,
        ..Routing::new(Provider::Claude)
    };
    reg.set_routing(routing).unwrap();
    reg.save(data.path()).unwrap();
    let back = Registry::load(data.path()).unwrap();
    let r = back.routing(Provider::Claude);
    assert_eq!(r.policy, Policy::Priority);
    assert_eq!(r.thresholds, [50, 95]);
    assert_eq!(r.pool, ["spare", "home"]);
    assert_eq!(back.routing(Provider::Codex), Routing::new(Provider::Codex));
}

#[test]
fn bad_routing_is_refused() {
    let data = TempDir::new().unwrap();
    let mut reg = registry(&data);
    let base = Routing::new(Provider::Claude);
    let bad = [
        Routing {
            pool: names(&["gpt"]),
            ..base.clone()
        },
        Routing {
            pool: names(&["nobody"]),
            ..base.clone()
        },
        Routing {
            priority: names(&["home", "home"]),
            ..base.clone()
        },
        Routing {
            thresholds: vec![0],
            ..base.clone()
        },
        Routing {
            thresholds: vec![101],
            ..base.clone()
        },
        Routing {
            thresholds: vec![10, 20, 30, 40, 50],
            ..base.clone()
        },
        Routing {
            switch_at: 0,
            ..base.clone()
        },
    ];
    for routing in bad {
        assert!(
            matches!(reg.set_routing(routing.clone()), Err(AiError::BadRouting)),
            "{routing:?}"
        );
    }
    assert_eq!(AiError::BadRouting.code(), "bad_routing");
}

#[test]
fn a_file_without_routing_or_with_a_broken_one_loads() {
    let data = TempDir::new().unwrap();
    registry(&data).save(data.path()).unwrap();
    let text = fs::read_to_string(data.path().join("accounts.json")).unwrap();
    assert!(!text.contains("routing"));
    let mut value: serde_json::Value = serde_json::from_str(&text).unwrap();
    value["routing"] = serde_json::json!([
        { "provider": "claude", "policy": "nonsense" },
        { "provider": "codex", "policy": "most_quota", "pool": [], "priority": [],
          "thresholds": [70], "autoSwitch": false, "switchAt": 95 }
    ]);
    fs::write(data.path().join("accounts.json"), value.to_string()).unwrap();
    let reg = Registry::load(data.path()).unwrap();
    assert_eq!(
        reg.routing(Provider::Claude),
        Routing::new(Provider::Claude)
    );
    assert_eq!(reg.routing(Provider::Codex).thresholds, [70]);
}

#[test]
fn removing_an_account_drops_it_from_routing() {
    let data = TempDir::new().unwrap();
    let mut reg = registry(&data);
    reg.set_routing(Routing {
        pool: names(&["home", "spare"]),
        priority: names(&["spare", "home"]),
        ..Routing::new(Provider::Claude)
    })
    .unwrap();
    reg.remove("spare").unwrap();
    let r = reg.routing(Provider::Claude);
    assert_eq!(r.pool, ["home"]);
    assert_eq!(r.priority, ["home"]);
}

#[test]
fn route_follows_the_policy_and_pool() {
    let data = TempDir::new().unwrap();
    let mut reg = registry(&data);
    let quotas = [used("work", 60.0), used("home", 10.0), used("spare", 5.0)];
    // Manual: the default whatever its quota.
    assert_eq!(
        reg.route(Provider::Claude, &quotas, None, None).as_deref(),
        Some("work")
    );
    reg.set_routing(Routing {
        policy: Policy::MostQuota,
        pool: names(&["work", "home"]),
        ..Routing::new(Provider::Claude)
    })
    .unwrap();
    assert_eq!(
        reg.route(Provider::Claude, &quotas, None, None).as_deref(),
        Some("home")
    );
    // Another provider's routing is its own.
    assert_eq!(reg.route(Provider::Codex, &quotas, None, None), None);
}

#[test]
fn route_skips_signed_out_accounts() {
    let data = TempDir::new().unwrap();
    let mut reg = registry(&data);
    reg.set_routing(Routing {
        policy: Policy::MostQuota,
        ..Routing::new(Provider::Claude)
    })
    .unwrap();
    let mut gone = used("spare", 0.0);
    gone.state = QuotaState::Unknown;
    gone.reason = Some(Reason::LoggedOut);
    gone.windows.clear();
    let quotas = [used("work", 60.0), used("home", 10.0), gone];
    assert_eq!(
        reg.route(Provider::Claude, &quotas, None, None).as_deref(),
        Some("home")
    );
}

#[test]
fn auto_switch_moves_new_agents_off_an_account_at_its_limit() {
    let data = TempDir::new().unwrap();
    let mut reg = registry(&data);
    reg.set_routing(Routing {
        auto_switch: true,
        switch_at: 80,
        ..Routing::new(Provider::Claude)
    })
    .unwrap();
    let quotas = [used("work", 85.0), used("home", 30.0), used("spare", 20.0)];
    assert_eq!(
        reg.route(Provider::Claude, &quotas, None, None).as_deref(),
        Some("spare")
    );
    let under = [used("work", 79.0)];
    assert_eq!(
        reg.route(Provider::Claude, &under, None, None).as_deref(),
        Some("work")
    );
}

#[test]
fn avoid_picks_another_account_or_none() {
    let data = TempDir::new().unwrap();
    let mut reg = registry(&data);
    let quotas = [used("work", 96.0), used("home", 30.0), used("spare", 20.0)];
    assert_eq!(
        reg.route(Provider::Claude, &quotas, None, Some("work"))
            .as_deref(),
        Some("spare")
    );
    reg.set_routing(Routing {
        pool: names(&["work"]),
        ..Routing::new(Provider::Claude)
    })
    .unwrap();
    assert_eq!(
        reg.route(Provider::Claude, &quotas, None, Some("work")),
        None
    );
}

#[test]
fn most_quota_never_picks_an_account_with_no_quota_source() {
    let data = TempDir::new().unwrap();
    let mut reg = registry(&data);
    reg.set_routing(Routing {
        policy: Policy::MostQuota,
        auto_switch: true,
        switch_at: 95,
        ..Routing::new(Provider::Claude)
    })
    .unwrap();
    let mut blind = used("spare", 0.0);
    blind.state = QuotaState::Unknown;
    blind.reason = Some(Reason::NoQuotaSource);
    blind.windows.clear();
    // Both known accounts are over the limit; an unknown one would be
    // picked as never over it, but quota unknown is left out.
    let quotas = [used("work", 97.0), used("home", 98.0), blind];
    assert_eq!(
        reg.route(Provider::Claude, &quotas, None, None).as_deref(),
        Some("work")
    );
}

fn gemini(data: &TempDir) -> Registry {
    let mut reg = Registry::load(data.path()).unwrap();
    for name in ["g1", "g2", "g3"] {
        reg.add(name, Provider::Gemini, data.path().join(name))
            .unwrap();
    }
    reg
}

#[test]
fn a_provider_without_quota_routes_by_round_robin_and_priority_only() {
    let data = TempDir::new().unwrap();
    let mut reg = gemini(&data);
    let err = reg
        .set_routing(Routing {
            policy: Policy::MostQuota,
            ..Routing::new(Provider::Gemini)
        })
        .unwrap_err();
    assert!(matches!(err, AiError::BadRouting));
    reg.set_routing(Routing {
        policy: Policy::RoundRobin,
        ..Routing::new(Provider::Gemini)
    })
    .unwrap();
    assert_eq!(
        reg.route(Provider::Gemini, &[], Some("g1"), None)
            .as_deref(),
        Some("g2")
    );
    reg.set_routing(Routing {
        policy: Policy::Priority,
        priority: names(&["g3"]),
        ..Routing::new(Provider::Gemini)
    })
    .unwrap();
    assert_eq!(
        reg.route(Provider::Gemini, &[], None, None).as_deref(),
        Some("g3")
    );
}

#[test]
fn use_another_account_without_quota_takes_the_next_one() {
    let data = TempDir::new().unwrap();
    let mut reg = gemini(&data);
    reg.activate(Provider::Gemini, Some("g1")).unwrap();
    assert_eq!(
        reg.route(Provider::Gemini, &[], Some("g1"), Some("g1"))
            .as_deref(),
        Some("g2")
    );
}

#[test]
fn a_single_account_provider_is_never_routed() {
    let data = TempDir::new().unwrap();
    let mut reg = Registry::load(data.path()).unwrap();
    reg.add("amp", Provider::Amp, data.path().join("amp"))
        .unwrap();
    assert!(matches!(
        reg.set_routing(Routing::new(Provider::Amp)),
        Err(AiError::BadRouting)
    ));
    assert_eq!(reg.route(Provider::Amp, &[], None, None), None);
    assert_eq!(reg.route(Provider::Amp, &[], None, Some("amp")), None);
}
