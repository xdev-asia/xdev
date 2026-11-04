//! The rows and enums of orchestration, as they cross the endpoint and the UI.

use serde::{Deserialize, Serialize};

macro_rules! string_enum {
    ($(#[$m:meta])* $name:ident { $($variant:ident),+ $(,)? }) => {
        $(#[$m])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[cfg_attr(feature = "ts", derive(ts_rs::TS))]
        #[serde(rename_all = "snake_case")]
        pub enum $name { $($variant),+ }
    };
}

string_enum!(TaskStatus {
    Pending,
    Ready,
    Dispatched,
    Completed,
    Failed,
    Blocked
});
string_enum!(DispatchStatus {
    Pending,
    Dispatched,
    Completed,
    Failed,
    CircuitBroken
});
string_enum!(
    /// Where a worker stands; `can_go` is the transition table.
    WorkerState { Starting, StartUnknown, Ready, Succeeded, Failed, Stopping, StopUnknown, Stopped, Abandoned }
);
string_enum!(MessageType {
    Status,
    Dispatch,
    WorkerDone,
    MergeReady,
    Escalation,
    Handoff,
    DecisionGate,
    Question,
    Heartbeat
});
string_enum!(Priority {
    Normal,
    High,
    Urgent
});
string_enum!(GateStatus {
    Pending,
    Resolved,
    Timeout
});
string_enum!(
    /// The step a failed worker start stopped at.
    FailedStage { TerminalCreate, SetupStart, AgentReadiness, SetupWait, DispatchInput }
);
string_enum!(StopReason {
    Finished,
    Errored,
    NeedsInput,
    Exited
});
string_enum!(Outcome { Succeeded, Failed });

impl WorkerState {
    /// The transitions the reference allows.
    ///
    /// starting      -> ready | start_unknown | failed | stopping | stopped | abandoned
    /// start_unknown -> ready | failed | stopping | stopped | abandoned
    /// ready         -> succeeded | failed | stopping | abandoned
    /// stopping      -> stopped | stop_unknown | ready | failed | abandoned
    /// stop_unknown  -> ready | failed | stopped | abandoned
    /// succeeded, failed, stopped, abandoned: no way out.
    pub fn can_go(self, to: WorkerState) -> bool {
        use WorkerState::*;
        match self {
            Starting => matches!(
                to,
                Ready | StartUnknown | Failed | Stopping | Stopped | Abandoned
            ),
            StartUnknown => matches!(to, Ready | Failed | Stopping | Stopped | Abandoned),
            Ready => matches!(to, Succeeded | Failed | Stopping | Abandoned),
            Stopping => matches!(to, Stopped | StopUnknown | Ready | Failed | Abandoned),
            StopUnknown => matches!(to, Ready | Failed | Stopped | Abandoned),
            Succeeded | Failed | Stopped | Abandoned => false,
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            WorkerState::Succeeded
                | WorkerState::Failed
                | WorkerState::Stopped
                | WorkerState::Abandoned
        )
    }
}

/// Where a worker's checkout comes from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum WorktreePick {
    Current,
    Selector(String),
    NewChild,
    NewTopLevel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub objective: String,
    pub coordinator_tab: Option<String>,
    pub created_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub run_id: String,
    pub title: Option<String>,
    pub spec: String,
    pub deps: Vec<String>,
    pub parent: Option<String>,
    pub status: TaskStatus,
    pub result: Option<String>,
    pub created_ms: i64,
    pub updated_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Dispatch {
    pub id: String,
    pub run_id: String,
    pub task_id: String,
    pub status: DispatchStatus,
    pub depth: u32,
    pub retry_of: Option<String>,
    pub failure_count: u32,
    pub parent_dispatch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Worker {
    pub dispatch_id: String,
    pub tab: Option<String>,
    pub worktree: String,
    pub agent: String,
    pub state: WorkerState,
    pub failed_stage: Option<FailedStage>,
    pub last_error: Option<String>,
    pub kept: bool,
    pub closes_at_ms: Option<i64>,
    pub released: bool,
    pub created_ms: i64,
    pub updated_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub run_id: String,
    pub from: String,
    pub to: String,
    pub subject: String,
    pub body: String,
    #[serde(rename = "type")]
    pub kind: MessageType,
    pub priority: Priority,
    pub thread_id: Option<String>,
    #[cfg_attr(feature = "ts", ts(type = "unknown"))]
    pub payload: Option<serde_json::Value>,
    pub read: bool,
    pub seq: i64,
    pub created_ms: i64,
    pub delivered_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Gate {
    pub id: String,
    pub run_id: String,
    pub task_id: String,
    pub question: String,
    pub options: Vec<String>,
    pub status: GateStatus,
    pub resolution: Option<String>,
    pub created_ms: i64,
}

/// What `worker-start` and the other worker verbs answer with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct WorkerReceipt {
    pub run_id: String,
    pub task_id: String,
    pub dispatch_id: String,
    pub state: WorkerState,
    pub failed_stage: Option<FailedStage>,
    pub last_error: Option<String>,
    pub recovery: Option<String>,
    pub next_commands: Vec<String>,
    pub next: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub messages: Vec<Message>,
    /// One text block per message, as an agent reads it.
    pub rendered: Vec<String>,
    pub remaining: u32,
    pub next: String,
}

#[cfg(test)]
mod tests {
    use super::WorkerState::*;
    use super::*;

    const ALL: [WorkerState; 9] = [
        Starting,
        StartUnknown,
        Ready,
        Succeeded,
        Failed,
        Stopping,
        StopUnknown,
        Stopped,
        Abandoned,
    ];

    fn allowed(from: WorkerState) -> Vec<WorkerState> {
        match from {
            Starting => vec![Ready, StartUnknown, Failed, Stopping, Stopped, Abandoned],
            StartUnknown => vec![Ready, Failed, Stopping, Stopped, Abandoned],
            Ready => vec![Succeeded, Failed, Stopping, Abandoned],
            Stopping => vec![Stopped, StopUnknown, Ready, Failed, Abandoned],
            StopUnknown => vec![Ready, Failed, Stopped, Abandoned],
            Succeeded | Failed | Stopped | Abandoned => vec![],
        }
    }

    fn json<T: Serialize>(v: &T) -> String {
        serde_json::to_string(v).unwrap()
    }

    #[test]
    fn the_transition_table_is_exactly_the_reference_one() {
        for from in ALL {
            for to in ALL {
                assert_eq!(
                    from.can_go(to),
                    allowed(from).contains(&to),
                    "{from:?} -> {to:?}"
                );
            }
        }
    }

    #[test]
    fn a_terminal_state_has_no_way_out() {
        for s in ALL {
            let terminal = matches!(s, Succeeded | Failed | Stopped | Abandoned);
            assert_eq!(s.is_terminal(), terminal);
            if terminal {
                assert!(ALL.iter().all(|t| !s.can_go(*t)));
            }
        }
    }

    #[test]
    fn enums_serialise_in_snake_case() {
        assert_eq!(json(&StartUnknown), "\"start_unknown\"");
        assert_eq!(json(&StopUnknown), "\"stop_unknown\"");
        assert_eq!(json(&MessageType::WorkerDone), "\"worker_done\"");
        assert_eq!(json(&MessageType::DecisionGate), "\"decision_gate\"");
        assert_eq!(json(&DispatchStatus::CircuitBroken), "\"circuit_broken\"");
        assert_eq!(json(&FailedStage::AgentReadiness), "\"agent_readiness\"");
        assert_eq!(json(&StopReason::NeedsInput), "\"needs_input\"");
        assert_eq!(json(&Priority::Urgent), "\"urgent\"");
    }

    #[test]
    fn a_worktree_pick_is_a_word_or_a_selector_object() {
        assert_eq!(json(&WorktreePick::Current), "\"current\"");
        assert_eq!(json(&WorktreePick::NewChild), "\"new_child\"");
        assert_eq!(json(&WorktreePick::NewTopLevel), "\"new_top_level\"");
        assert_eq!(
            json(&WorktreePick::Selector("settings".into())),
            r#"{"selector":"settings"}"#
        );
        let back: WorktreePick = serde_json::from_str(r#"{"selector":"x"}"#).unwrap();
        assert_eq!(back, WorktreePick::Selector("x".into()));
    }

    #[test]
    fn a_message_has_a_type_field_and_camel_case_keys() {
        let m = Message {
            id: "msg_1".into(),
            run_id: "run_1".into(),
            from: "run:run_1".into(),
            to: "dispatch:d".into(),
            subject: "s".into(),
            body: "b".into(),
            kind: MessageType::Question,
            priority: Priority::Normal,
            thread_id: None,
            payload: None,
            read: false,
            seq: 1,
            created_ms: 5,
            delivered_ms: None,
        };
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(v["type"], "question");
        assert_eq!(v["runId"], "run_1");
        assert_eq!(v["createdMs"], 5);
    }
}
