use super::*;
use tempfile::tempdir;

fn command(program: &str) -> Action {
    Action::RunCommand {
        program: program.to_owned(),
        args: vec!["test".to_owned()],
        cwd: PathBuf::from("repo"),
    }
}

fn merge() -> Action {
    Action::Merge {
        from: "task".to_owned(),
        into: "main".to_owned(),
    }
}

#[test]
fn defaults() {
    let policy = Policy::default();
    assert_eq!(
        policy.agent_tools,
        ["Read", "Edit", "Write", "Grep", "Glob"]
    );
    assert!(policy.commands.is_empty());
    assert_eq!(policy.merge, Rule::Ask);
    assert_eq!(policy.delete, Rule::Ask);
    assert_eq!(serde_json::from_str::<Policy>("{}").unwrap(), policy);
}

#[test]
fn missing_policy_uses_defaults() {
    let dir = tempdir().unwrap();
    assert_eq!(Policy::load(dir.path()).unwrap(), Policy::default());
}

#[test]
fn save_creates_directory_and_round_trips() {
    let dir = tempdir().unwrap();
    let data = dir.path().join("data");
    let policy = Policy {
        commands: vec!["cargo".to_owned()],
        merge: Rule::Deny,
        delete: Rule::Deny,
        ..Policy::default()
    };
    policy.save(&data).unwrap();
    assert_eq!(Policy::load(&data).unwrap(), policy);
    let text = fs::read_to_string(data.join("policy.json")).unwrap();
    assert!(text.contains("\n  \"agent_tools\""));
    assert!(text.contains("\"merge\": \"deny\""));
}

#[test]
fn invalid_policy_is_rejected() {
    let dir = tempdir().unwrap();
    for text in [
        r#"{"merge":"allow"}"#,
        r#"{"delete":"allow"}"#,
        r#"{"unknown":true}"#,
        "not json",
    ] {
        fs::write(dir.path().join("policy.json"), text).unwrap();
        assert_eq!(
            Policy::load(dir.path()).unwrap_err().code(),
            "policy_invalid"
        );
    }
}

#[test]
fn io_error_has_stable_code() {
    let dir = tempdir().unwrap();
    fs::create_dir(dir.path().join("policy.json")).unwrap();
    assert_eq!(Policy::load(dir.path()).unwrap_err().code(), "io");
}

#[test]
fn agent_tools_require_approval_for_extras() {
    let policy = Policy::default();
    let mut action = Action::SpawnAgent {
        provider: "claude".to_owned(),
        account: None,
        worktree: PathBuf::from("worktree"),
        tools: policy.agent_tools.clone(),
    };
    assert_eq!(policy.check(&action), Verdict::Allow);
    if let Action::SpawnAgent { tools, .. } = &mut action {
        tools.extend(["Bash".to_owned(), "Other".to_owned()]);
    }
    let Verdict::Ask { reason } = policy.check(&action) else {
        panic!("extra tools must require approval");
    };
    assert!(reason.contains("Bash"));
    assert!(reason.contains("Other"));
}

#[test]
fn commands_match_program_stems() {
    let policy = Policy {
        commands: vec!["cargo".to_owned()],
        ..Policy::default()
    };
    for program in ["cargo", "cargo.exe", "path/to/cargo.exe"] {
        assert_eq!(policy.check(&command(program)), Verdict::Allow);
    }
    #[cfg(windows)]
    for program in [r"C:\x\cargo.exe", r"C:\x\CARGO.EXE", "Cargo"] {
        assert_eq!(policy.check(&command(program)), Verdict::Allow);
    }
    let Verdict::Ask { reason } = policy.check(&command("rustc")) else {
        panic!("unlisted commands must require approval");
    };
    assert!(reason.contains("rustc"));
    assert!(matches!(
        Policy::default().check(&command("cargo")),
        Verdict::Ask { .. }
    ));
}

#[test]
fn merge_and_delete_never_allow() {
    let delete = Action::Delete {
        path: PathBuf::from("repo"),
    };
    for rule in [Rule::Ask, Rule::Deny] {
        let policy = Policy {
            merge: rule,
            delete: rule,
            ..Policy::default()
        };
        for action in [merge(), delete.clone()] {
            match rule {
                Rule::Ask => assert!(matches!(policy.check(&action), Verdict::Ask { .. })),
                Rule::Deny => assert!(matches!(policy.check(&action), Verdict::Deny { .. })),
            }
        }
    }
}

#[test]
fn force_push_always_asks() {
    let action = Action::ForcePush {
        worktree: PathBuf::from("wt"),
        remote: "origin".to_owned(),
        branch: "feat".to_owned(),
    };
    let ask = Verdict::Ask {
        reason: "force push always asks".to_owned(),
    };
    for policy in [
        Policy::default(),
        Policy {
            merge: Rule::Deny,
            delete: Rule::Deny,
            commands: vec!["git".to_owned()],
            ..Policy::default()
        },
    ] {
        assert_eq!(policy.check(&action), ask);
    }
    let dir = tempdir().unwrap();
    let gate = Audited::new(Policy::default(), dir.path());
    assert_eq!(gate.check_confirmed(&action, false), ask);
    assert_eq!(gate.check(&action), ask);
    // A confirmation is the only way through.
    assert_eq!(gate.check_confirmed(&action, true), Verdict::Allow);
}

#[test]
fn audit_records_checks_in_order() {
    let dir = tempdir().unwrap();
    let data = dir.path().join("data");
    let gate = Audited::new(Policy::default(), &data);
    let actions = [command("cargo"), merge()];
    let before = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let verdicts = actions.each_ref().map(|action| gate.check(action));
    let text = fs::read_to_string(data.join("audit.jsonl")).unwrap();
    assert_eq!(text.lines().count(), 2);
    fs::write(data.join("audit.jsonl"), format!("\n{text}\n   \n")).unwrap();
    let entries = read_audit(&data).unwrap();
    assert_eq!(entries.len(), 2);
    for (index, entry) in entries.iter().enumerate() {
        assert_eq!(entry.action, actions[index]);
        assert_eq!(entry.verdict, verdicts[index]);
        assert!(entry.at >= before);
    }
}

#[test]
fn unwritable_audit_denies_allowed_action() {
    let dir = tempdir().unwrap();
    fs::create_dir(dir.path().join("audit.jsonl")).unwrap();
    let gate = Audited::new(
        Policy {
            commands: vec!["cargo".to_owned()],
            ..Policy::default()
        },
        dir.path(),
    );
    assert_eq!(
        gate.check(&command("cargo")),
        Verdict::Deny {
            reason: "audit log not writable".to_owned()
        }
    );
}

#[test]
fn invalid_audit_returns_parse_error() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("audit.jsonl"), "invalid\n").unwrap();
    assert_eq!(read_audit(dir.path()).unwrap_err().code(), "policy_invalid");
}

#[test]
fn launch_agent_asks_first_then_allows_approved() {
    let action = |perm: &str| Action::LaunchAgent {
        profile: "claude".into(),
        program: "claude".into(),
        args: vec![],
        permissions: perm.into(),
    };
    let mut p = Policy::default();
    assert!(matches!(p.check(&action("ask")), Verdict::Ask { .. }));
    p.approved_agents
        .push(agent_fingerprint("claude", &[], "ask"));
    assert_eq!(p.check(&action("ask")), Verdict::Allow);
    p.approved_agents
        .push(agent_fingerprint("claude", &[], "skip"));
    assert!(matches!(p.check(&action("skip")), Verdict::Ask { .. }));
}

#[test]
fn old_policy_file_loads() {
    let p: Policy = serde_json::from_str(r#"{"merge":"ask"}"#).unwrap();
    assert!(p.approved_agents.is_empty());
}

#[test]
fn source_stays_text_so_diffs_of_the_gate_are_readable() {
    assert!(!include_bytes!("lib.rs").contains(&0));
}

#[test]
fn confirmed_ask_is_logged_as_allow() {
    let dir = tempdir().unwrap();
    let gate = Audited::new(Policy::default(), dir.path());
    let action = merge();
    assert!(matches!(
        gate.check_confirmed(&action, false),
        Verdict::Ask { .. }
    ));
    assert_eq!(gate.check_confirmed(&action, true), Verdict::Allow);
    let verdicts: Vec<_> = read_audit(dir.path())
        .unwrap()
        .into_iter()
        .map(|entry| entry.verdict)
        .collect();
    assert!(matches!(
        verdicts[..],
        [Verdict::Ask { .. }, Verdict::Allow]
    ));
}

#[test]
fn confirmation_does_not_lift_a_deny() {
    let dir = tempdir().unwrap();
    let gate = Audited::new(
        Policy {
            merge: Rule::Deny,
            ..Policy::default()
        },
        dir.path(),
    );
    assert!(matches!(
        gate.check_confirmed(&merge(), true),
        Verdict::Deny { .. }
    ));
}

#[test]
fn discard_always_asks_until_confirmed() {
    let action = Action::Discard {
        worktree: PathBuf::from("wt"),
        paths: vec!["a.txt".to_owned()],
    };
    let ask = Verdict::Ask {
        reason: "discarding changes always asks".to_owned(),
    };
    for policy in [
        Policy::default(),
        Policy {
            delete: Rule::Deny,
            commands: vec!["git".to_owned()],
            ..Policy::default()
        },
    ] {
        assert_eq!(policy.check(&action), ask);
    }
    let dir = tempdir().unwrap();
    let gate = Audited::new(Policy::default(), dir.path());
    assert_eq!(gate.check_confirmed(&action, false), ask);
    assert_eq!(gate.check_confirmed(&action, true), Verdict::Allow);
    let log = read_audit(dir.path()).unwrap();
    assert_eq!(log.len(), 2);
    assert_eq!(log[1].action, action);
}

#[test]
fn cli_worktree_writes_pass_for_own_and_family_and_ask_otherwise() {
    let policy = Policy::default();
    let action = |op: &str, scope: &str| Action::CliWorktree {
        op: op.into(),
        worktree: "/w".into(),
        scope: scope.into(),
    };
    assert_eq!(policy.check(&action("set", "own")), Verdict::Allow);
    assert_eq!(policy.check(&action("create", "own")), Verdict::Allow);
    assert_eq!(policy.check(&action("create", "family")), Verdict::Allow);
    assert_eq!(policy.check(&action("set", "family")), Verdict::Allow);
    assert!(matches!(
        policy.check(&action("rm", "family")),
        Verdict::Ask { .. }
    ));
    assert!(matches!(
        policy.check(&action("set", "other")),
        Verdict::Ask { .. }
    ));
    assert!(matches!(
        policy.check(&action("create", "external")),
        Verdict::Ask { .. }
    ));
}

fn cli(op: &str, scope: &str) -> Action {
    Action::CliWorktree {
        op: op.into(),
        worktree: "/w".into(),
        scope: scope.into(),
    }
}

#[test]
fn cli_send_in_own_or_family_scope_is_allowed() {
    let policy = Policy::default();
    assert_eq!(policy.check(&cli("send", "own")), Verdict::Allow);
    assert_eq!(policy.check(&cli("send", "family")), Verdict::Allow);
}

#[test]
fn cli_send_elsewhere_asks() {
    let policy = Policy::default();
    for scope in ["other", "external"] {
        assert!(
            matches!(policy.check(&cli("send", scope)), Verdict::Ask { .. }),
            "{scope}"
        );
    }
}

#[test]
fn a_refusal_is_audited_as_deny() {
    let dir = tempfile::tempdir().unwrap();
    let gate = Audited::new(Policy::default(), dir.path());
    let action = Action::CliWorktree {
        op: "set".into(),
        worktree: "/w".into(),
        scope: "other".into(),
    };
    assert!(matches!(gate.refused(&action, "no"), Verdict::Deny { .. }));
    let log = read_audit(dir.path()).unwrap();
    assert_eq!(log.len(), 1);
    assert_eq!(
        log[0].verdict,
        Verdict::Deny {
            reason: "no".into()
        }
    );
}
