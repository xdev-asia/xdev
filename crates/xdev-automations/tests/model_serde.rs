use xdev_automations::{FailureCode, RunStatus, RunTrigger, SetupDecision, WorkspaceMode};

fn wire<T: serde::Serialize>(v: T) -> String {
    serde_json::to_string(&v).unwrap()
}

#[test]
fn enums_use_their_wire_strings() {
    assert_eq!(wire(WorkspaceMode::NewPerRun), "\"new_per_run\"");
    assert_eq!(wire(WorkspaceMode::Existing), "\"existing\"");
    assert_eq!(wire(SetupDecision::Inherit), "\"inherit\"");
    assert_eq!(
        wire(RunStatus::SkippedNeedsInteractiveAuth),
        "\"skipped_needs_interactive_auth\""
    );
    assert_eq!(wire(RunStatus::DispatchFailed), "\"dispatch_failed\"");
    assert_eq!(wire(RunTrigger::Scheduled), "\"scheduled\"");
    assert_eq!(
        wire(FailureCode::MissedGraceWindow),
        "\"missedGraceWindow\""
    );
    assert_eq!(wire(FailureCode::NoDispatchHost), "\"noDispatchHost\"");
}

#[test]
fn enums_read_back() {
    let status: RunStatus = serde_json::from_str("\"skipped_precheck\"").unwrap();
    assert_eq!(status, RunStatus::SkippedPrecheck);
    let code: FailureCode = serde_json::from_str("\"agentNeverStarted\"").unwrap();
    assert_eq!(code, FailureCode::AgentNeverStarted);
    let mode: WorkspaceMode = serde_json::from_str("\"new_per_run\"").unwrap();
    assert_eq!(mode, WorkspaceMode::NewPerRun);
}

#[test]
fn only_the_first_three_statuses_are_not_final() {
    use RunStatus::*;
    for s in [Pending, Dispatching, Dispatched] {
        assert!(!s.is_final(), "{s:?}");
    }
    for s in [
        Completed,
        SkippedPrecheck,
        SkippedMissed,
        SkippedUnavailable,
        SkippedNeedsInteractiveAuth,
        DispatchFailed,
    ] {
        assert!(s.is_final(), "{s:?}");
    }
}
