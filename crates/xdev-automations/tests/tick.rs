use xdev_automations::tick::{TickStep, Watch, plan, watchdog};
use xdev_automations::*;

const MIN: i64 = 60_000;
const TICK: i64 = DEFAULT_TICK_MS;
const T0: i64 = 1_793_872_800_000; // 2026-11-05T10:00:00Z (a Thursday)

fn auto(id: &str, rrule: &str, next_run_at: i64, grace: u32) -> Automation {
    Automation {
        id: id.into(),
        name: id.into(),
        prompt: "p".into(),
        precheck: None,
        agent: "claude".into(),
        extra_agent_args: None,
        repo_id: "r".into(),
        workspace_mode: WorkspaceMode::Existing,
        worktree: Some("/w".into()),
        base_branch: None,
        setup_decision: SetupDecision::Inherit,
        reuse_session: false,
        timezone: "UTC".into(),
        rrule: rrule.into(),
        dtstart: 0,
        enabled: true,
        next_run_at,
        last_run_at: None,
        missed_run_grace_minutes: grace,
        created_at: 0,
        updated_at: 0,
    }
}

const HOURLY: &str = "FREQ=HOURLY;BYMINUTE=0";

#[test]
fn a_disabled_or_not_yet_due_automation_is_left_alone() {
    let mut off = auto("off", HOURLY, T0 - MIN, 720);
    off.enabled = false;
    let later = auto("later", HOURLY, T0 + MIN, 720);
    assert!(plan(&[off, later], T0, TICK, true).is_empty());
}

#[test]
fn a_due_automation_within_grace_dispatches_its_latest_occurrence() {
    let a = auto("a", HOURLY, T0 - 3 * MIN, 720);
    // The 10:00 occurrence, 3 minutes ago at 10:03.
    let now = T0 + 3 * MIN;
    assert_eq!(
        plan(&[a], now, TICK, true),
        vec![TickStep::Dispatch {
            id: "a".into(),
            scheduled_for: T0
        }]
    );
}

#[test]
fn the_jitter_allowance_is_two_ticks_past_the_grace() {
    let a = auto("a", HOURLY, T0, 0);
    let on_edge = T0 + 2 * TICK;
    assert_eq!(
        plan(std::slice::from_ref(&a), on_edge, TICK, true),
        vec![TickStep::Dispatch {
            id: "a".into(),
            scheduled_for: T0
        }]
    );
    assert_eq!(
        plan(&[a], on_edge + 1, TICK, true),
        vec![TickStep::Missed {
            id: "a".into(),
            scheduled_for: T0
        }]
    );
    let with_grace = auto("g", HOURLY, T0, 30);
    assert_eq!(
        plan(
            std::slice::from_ref(&with_grace),
            T0 + 30 * MIN + 2 * TICK,
            TICK,
            true
        ),
        vec![TickStep::Dispatch {
            id: "g".into(),
            scheduled_for: T0
        }]
    );
    assert_eq!(
        plan(&[with_grace], T0 + 30 * MIN + 2 * TICK + 1, TICK, true),
        vec![TickStep::Missed {
            id: "g".into(),
            scheduled_for: T0
        }]
    );
}

#[test]
fn without_a_window_the_run_is_refused() {
    let a = auto("a", HOURLY, T0, 720);
    assert_eq!(
        plan(&[a], T0 + MIN, TICK, false),
        vec![TickStep::Refuse {
            id: "a".into(),
            scheduled_for: T0,
            code: FailureCode::NoDispatchHost
        }]
    );
}

#[test]
fn a_malformed_rule_is_reported_and_does_not_block_the_others() {
    let bad = auto("bad", "FREQ=MONTHLY", T0, 720);
    let good = auto("good", HOURLY, T0, 720);
    let steps = plan(&[bad, good], T0 + MIN, TICK, true);
    assert!(matches!(&steps[0], TickStep::Unevaluable { id, .. } if id == "bad"));
    assert_eq!(
        steps[1],
        TickStep::Dispatch {
            id: "good".into(),
            scheduled_for: T0
        }
    );
}

#[test]
fn a_laptop_asleep_for_days_misses_once_and_does_not_replay() {
    let daily = "FREQ=DAILY;BYHOUR=9;BYMINUTE=0";
    // Due since 3 days ago; now is 12:00 three days later; grace 30 min.
    let a_due = 1_793_786_400_000; // 2026-11-04T10:00Z, the first occurrence it slept through
    let mut a = auto("a", daily, a_due, 30);
    let now = 1_793_872_800_000 + 3 * 86_400_000 + 2 * 3_600_000; // 2026-11-08T12:00Z
    let steps = plan(std::slice::from_ref(&a), now, TICK, true);
    assert_eq!(steps.len(), 1);
    // The newest occurrence only: 2026-11-08T09:00Z.
    assert_eq!(
        steps,
        vec![TickStep::Missed {
            id: "a".into(),
            scheduled_for: 1_794_128_400_000
        }]
    );
    // Once the service has advanced next_run_at past now, nothing is left to do.
    a.next_run_at = 1_794_214_800_000; // 2026-11-09T09:00Z
    assert!(plan(&[a], now, TICK, true).is_empty());
}

#[test]
fn a_due_rule_with_no_occurrence_yet_just_advances() {
    let mut a = auto("a", HOURLY, T0 - MIN, 720);
    a.dtstart = T0 + 3_600_000;
    assert_eq!(
        plan(&[a], T0, TICK, true),
        vec![TickStep::Advance { id: "a".into() }]
    );
}

fn run(status: RunStatus, started: Option<i64>, dispatched: Option<i64>) -> AutomationRun {
    AutomationRun {
        id: "r".into(),
        automation_id: "a".into(),
        title: "t".into(),
        run_number: 1,
        scheduled_for: 0,
        status,
        trigger: RunTrigger::Scheduled,
        worktree: None,
        worktree_name: None,
        tab_id: None,
        output_snapshot: None,
        precheck_result: None,
        error: None,
        error_code: None,
        error_params: None,
        started_at: started,
        dispatched_at: dispatched,
        finished_at: None,
        created_at: 0,
        occurrence_count: 1,
        last_occurrence_at: None,
    }
}

#[test]
fn the_watchdog_gives_a_start_two_minutes_and_a_run_six_hours() {
    let two = AGENT_START_DEADLINE_MS;
    let six = OBSERVE_DEADLINE_MS;
    let starting = run(RunStatus::Dispatching, Some(1_000), None);
    assert_eq!(watchdog(&starting, 1_000 + two), Watch::Keep);
    assert_eq!(
        watchdog(&starting, 1_000 + two + 1),
        Watch::Fail(FailureCode::AgentNeverStarted)
    );
    let running = run(RunStatus::Dispatched, Some(1_000), Some(5_000));
    assert_eq!(watchdog(&running, 5_000 + six), Watch::Keep);
    assert_eq!(
        watchdog(&running, 5_000 + six + 1),
        Watch::Fail(FailureCode::WatchTimedOut)
    );
    for done in [
        RunStatus::Pending,
        RunStatus::Completed,
        RunStatus::SkippedMissed,
        RunStatus::DispatchFailed,
    ] {
        assert_eq!(
            watchdog(&run(done, Some(0), Some(0)), i64::MAX / 2),
            Watch::Keep,
            "{done:?}"
        );
    }
}
