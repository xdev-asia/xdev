//! The Runs dashboard's data: every automation run in a time range, joined with the token usage
//! of the agent session that ran it, and the totals per automation and overall.
//!
//! The join and the sums are pure functions: they take the automations, the runs, the usage
//! sessions and `now`, and read no disk and no clock.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use xdev_automations::{Automation, AutomationRun, RunStatus};
use xdev_kit::{Agent, Cost, SessionUsage, UsageIndex, cost_nanos, rates_for};

use crate::automations::AutomationService;
use crate::commands::{AppState, CmdError};
use crate::kit::Ctx;

const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 24 * HOUR_MS;
/// The model name Claude Code gives to messages it made up itself; it has no price.
const SYNTHETIC: &str = "<synthetic>";

/// How far back the dashboard looks.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum RunsRange {
    #[serde(rename = "24h")]
    Day,
    #[default]
    #[serde(rename = "7d")]
    Week,
    #[serde(rename = "30d")]
    Month,
}

impl RunsRange {
    fn millis(self) -> i64 {
        match self {
            RunsRange::Day => DAY_MS,
            RunsRange::Week => 7 * DAY_MS,
            RunsRange::Month => 30 * DAY_MS,
        }
    }
}

/// What a run's agent session used. Only present when the session was matched, see [`join`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RunUsage {
    pub tokens_in: u64,
    pub tokens_out: u64,
    /// Cache reads and writes.
    pub tokens_cache: u64,
    pub cost: Cost,
}

impl RunUsage {
    pub fn tokens(&self) -> u64 {
        self.tokens_in
            .saturating_add(self.tokens_out)
            .saturating_add(self.tokens_cache)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RunRow {
    pub run_id: String,
    pub automation_id: String,
    pub automation_name: String,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub status: RunStatus,
    /// `finished - started`, when the run has both.
    pub duration_ms: Option<i64>,
    /// The agent profile id of the automation.
    pub agent: String,
    /// `None` when no session could be matched; never an estimate.
    pub usage: Option<RunUsage>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RunTotals {
    pub runs: u32,
    /// Completed runs.
    pub ok: u32,
    /// Runs that failed to start.
    pub failed: u32,
    /// Runs that have usage; the tokens and cost cover these only.
    pub with_usage: u32,
    pub tokens: u64,
    pub cost: Cost,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AutomationTotals {
    pub automation_id: String,
    pub automation_name: String,
    pub totals: RunTotals,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RunsSummary {
    pub range: RunsRange,
    /// Unix ms; runs that began before it are left out.
    pub since: i64,
    /// Newest first.
    pub runs: Vec<RunRow>,
    pub by_automation: Vec<AutomationTotals>,
    pub totals: RunTotals,
}

/// The time a run is placed at: when it started, else when it was due.
fn run_time(run: &AutomationRun) -> i64 {
    run.started_at.unwrap_or(run.scheduled_for)
}

fn same_folder(a: &str, b: &str) -> bool {
    a.trim_end_matches(['/', '\\']) == b.trim_end_matches(['/', '\\'])
}

/// The cost of a whole session: each model's tokens at that model's rate.
fn session_cost(s: &SessionUsage) -> Cost {
    let mut cost = Cost::default();
    for (model, _, t) in s.model_days() {
        if model == SYNTHETIC || t.sum() == 0 {
            continue;
        }
        match rates_for(s.agent, model) {
            Some(r) => {
                cost.nanos = cost.nanos.saturating_add(cost_nanos(r, t));
                cost.priced = true;
            }
            None => cost.unpriced = true,
        }
    }
    cost
}

fn add_cost(into: &mut Cost, other: &Cost) {
    into.nanos = into.nanos.saturating_add(other.nanos);
    into.priced |= other.priced;
    into.unpriced |= other.unpriced;
}

/// Matches runs to usage sessions. The usage index knows a session by its log id, folder and
/// first/last message time; a run records no session id, so the most exact key left is the
/// folder the agent ran in plus the time:
///
/// - the run has a `worktree` and a start time (`started_at`, else `dispatched_at`);
/// - the session's folder is that worktree (trailing separators ignored) and, when the
///   automation's agent is `claude` or `codex`, the session is that agent's;
/// - the session's `first..=last` overlaps the run's `start..=end` (`end` is `finished_at`, or
///   `now` while the run is open);
/// - a session that fits more than one run (a reused session or worktree) is ambiguous and is
///   given to none, so no tokens are counted twice or guessed.
///
/// A run with no matching session has no usage. Returns the usage by run id.
pub fn join(
    automations: &[Automation],
    runs: &[AutomationRun],
    sessions: &[&SessionUsage],
    now: i64,
) -> HashMap<String, RunUsage> {
    let agent_of: HashMap<&str, &str> = automations
        .iter()
        .map(|a| (a.id.as_str(), a.agent.as_str()))
        .collect();

    // session index -> runs it fits; run index -> sessions it fits
    let mut claims: Vec<Vec<usize>> = vec![Vec::new(); sessions.len()];
    let mut fits: Vec<Vec<usize>> = vec![Vec::new(); runs.len()];
    for (ri, run) in runs.iter().enumerate() {
        let (Some(dir), Some(start)) = (
            run.worktree.as_deref(),
            run.started_at.or(run.dispatched_at),
        ) else {
            continue;
        };
        let end = run.finished_at.unwrap_or(now);
        let wanted = match agent_of.get(run.automation_id.as_str()).copied() {
            Some("claude") => Some(Agent::Claude),
            Some("codex") => Some(Agent::Codex),
            _ => None,
        };
        for (si, s) in sessions.iter().enumerate() {
            let folder_ok = s.folder.as_deref().is_some_and(|f| same_folder(f, dir));
            let agent_ok = wanted.is_none_or(|a| a == s.agent);
            if folder_ok && agent_ok && s.first > 0 && s.first <= end && s.last >= start {
                claims[si].push(ri);
                fits[ri].push(si);
            }
        }
    }

    let mut out = HashMap::new();
    for (ri, run) in runs.iter().enumerate() {
        let mine: Vec<&&SessionUsage> = fits[ri]
            .iter()
            .filter(|&&si| claims[si].len() == 1)
            .map(|&si| &sessions[si])
            .collect();
        if mine.is_empty() {
            continue;
        }
        let mut usage = RunUsage {
            tokens_in: 0,
            tokens_out: 0,
            tokens_cache: 0,
            cost: Cost::default(),
        };
        for s in mine {
            usage.tokens_in = usage.tokens_in.saturating_add(s.total.input);
            usage.tokens_out = usage.tokens_out.saturating_add(s.total.output);
            usage.tokens_cache = usage
                .tokens_cache
                .saturating_add(s.total.cache_read)
                .saturating_add(s.total.cache_write);
            add_cost(&mut usage.cost, &session_cost(s));
        }
        out.insert(run.id.clone(), usage);
    }
    out
}

fn tally(t: &mut RunTotals, row: &RunRow) {
    t.runs += 1;
    match row.status {
        RunStatus::Completed => t.ok += 1,
        RunStatus::DispatchFailed => t.failed += 1,
        _ => {}
    }
    if let Some(u) = &row.usage {
        t.with_usage += 1;
        t.tokens = t.tokens.saturating_add(u.tokens());
        add_cost(&mut t.cost, &u.cost);
    }
}

/// The runs that began in the last `range` before `now`, newest first, with their usage and the
/// totals. A run of an automation that is gone from `automations` is left out.
pub fn summarize(
    automations: &[Automation],
    runs: &[AutomationRun],
    sessions: &[&SessionUsage],
    range: RunsRange,
    now: i64,
) -> RunsSummary {
    let since = now.saturating_sub(range.millis());
    let names: HashMap<&str, &Automation> =
        automations.iter().map(|a| (a.id.as_str(), a)).collect();
    let mut kept: Vec<AutomationRun> = runs
        .iter()
        .filter(|r| {
            names.contains_key(r.automation_id.as_str())
                && run_time(r) >= since
                && run_time(r) <= now
        })
        .cloned()
        .collect();
    kept.sort_by_key(|r| std::cmp::Reverse(run_time(r)));
    let usage = join(automations, &kept, sessions, now);

    let mut totals = RunTotals::default();
    let mut per: BTreeMap<&str, RunTotals> = BTreeMap::new();
    let rows: Vec<RunRow> = kept
        .iter()
        .map(|r| {
            let a = names[r.automation_id.as_str()];
            let row = RunRow {
                run_id: r.id.clone(),
                automation_id: a.id.clone(),
                automation_name: a.name.clone(),
                started_at: r.started_at,
                finished_at: r.finished_at,
                status: r.status,
                duration_ms: match (r.started_at, r.finished_at) {
                    (Some(s), Some(f)) if f >= s => Some(f - s),
                    _ => None,
                },
                agent: a.agent.clone(),
                usage: usage.get(&r.id).copied(),
            };
            tally(&mut totals, &row);
            tally(per.entry(a.id.as_str()).or_default(), &row);
            row
        })
        .collect();
    let by_automation = per
        .into_iter()
        .map(|(id, totals)| AutomationTotals {
            automation_id: id.to_owned(),
            automation_name: names[id].name.clone(),
            totals,
        })
        .collect();
    RunsSummary {
        range,
        since,
        runs: rows,
        by_automation,
        totals,
    }
}

/// The dashboard's list. Usage comes from the saved usage index as the Stats page last
/// refreshed it, so a run is without usage until its session is in that index.
#[tauri::command(async)]
pub fn automation_runs_summary(
    app: AppHandle,
    range: Option<RunsRange>,
) -> Result<RunsSummary, CmdError> {
    let service = app.try_state::<AutomationService>().ok_or(CmdError {
        code: "bad_arg",
        detail: Some("no data folder".into()),
    })?;
    let (automations, runs, now) = service.snapshot();
    let ctx = Ctx::of(&app.state::<AppState>())?;
    let index = UsageIndex::load(&ctx.data);
    let sessions: Vec<&SessionUsage> = index.sessions.values().collect();
    Ok(summarize(
        &automations,
        &runs,
        &sessions,
        range.unwrap_or_default(),
        now,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use xdev_kit::Tokens;

    const T0: i64 = 1_800_000_000_000;

    fn automation(id: &str, agent: &str) -> Automation {
        serde_json::from_value(serde_json::json!({
            "id": id, "name": format!("Auto {id}"), "prompt": "p", "precheck": null,
            "agent": agent, "extraAgentArgs": null, "repoId": "r", "workspaceMode": "existing",
            "worktree": null, "baseBranch": null, "setupDecision": "inherit", "reuseSession": false,
            "timezone": "UTC", "rrule": "", "dtstart": 0, "enabled": true, "nextRunAt": 0,
            "lastRunAt": null, "missedRunGraceMinutes": 0, "createdAt": 0, "updatedAt": 0
        }))
        .expect("automation fixture")
    }

    fn run(
        id: &str,
        auto: &str,
        status: RunStatus,
        start: Option<i64>,
        end: Option<i64>,
        dir: Option<&str>,
    ) -> AutomationRun {
        serde_json::from_value(serde_json::json!({
            "id": id, "automationId": auto, "title": id, "runNumber": 1,
            "scheduledFor": start.unwrap_or(T0), "status": status, "trigger": "scheduled",
            "worktree": dir, "worktreeName": null, "tabId": null, "outputSnapshot": null,
            "precheckResult": null, "error": null, "errorCode": null, "errorParams": null,
            "startedAt": start, "dispatchedAt": null, "finishedAt": end, "createdAt": 0,
            "occurrenceCount": 1, "lastOccurrenceAt": null
        }))
        .expect("run fixture")
    }

    fn session(
        id: &str,
        agent: Agent,
        dir: &str,
        first: i64,
        last: i64,
        input: u64,
        output: u64,
    ) -> SessionUsage {
        let total = Tokens {
            input,
            output,
            cache_read: 0,
            cache_write: 0,
        };
        let model = "claude-sonnet-4-5".to_owned();
        let mut days = BTreeMap::new();
        days.insert("2027-01-15".to_owned(), total);
        SessionUsage {
            id: id.to_owned(),
            home_id: "h".into(),
            agent,
            folder: Some(dir.to_owned()),
            model: Some(model),
            first,
            last,
            total,
            days,
            models: BTreeMap::new(),
        }
    }

    const MIN: i64 = 60_000;

    #[test]
    fn a_session_in_the_runs_folder_and_window_is_its_usage() {
        let autos = [automation("a", "claude")];
        let runs = [run(
            "r1",
            "a",
            RunStatus::Completed,
            Some(T0),
            Some(T0 + 10 * MIN),
            Some("/w/one"),
        )];
        let s = session(
            "s",
            Agent::Claude,
            "/w/one/",
            T0 + MIN,
            T0 + 9 * MIN,
            100,
            50,
        );
        let got = join(&autos, &runs, &[&s], T0 + HOUR_MS);
        let u = got.get("r1").expect("matched");
        assert_eq!((u.tokens_in, u.tokens_out, u.tokens_cache), (100, 50, 0));
    }

    #[test]
    fn another_folder_time_or_agent_gives_no_usage() {
        let autos = [automation("a", "claude")];
        let runs = [run(
            "r1",
            "a",
            RunStatus::Completed,
            Some(T0),
            Some(T0 + 10 * MIN),
            Some("/w/one"),
        )];
        let other_dir = session("s1", Agent::Claude, "/w/two", T0, T0 + MIN, 1, 1);
        let before = session(
            "s2",
            Agent::Claude,
            "/w/one",
            T0 - 20 * MIN,
            T0 - 5 * MIN,
            1,
            1,
        );
        let after = session(
            "s3",
            Agent::Claude,
            "/w/one",
            T0 + 11 * MIN,
            T0 + 12 * MIN,
            1,
            1,
        );
        let other_agent = session("s4", Agent::Codex, "/w/one", T0, T0 + MIN, 1, 1);
        let got = join(
            &autos,
            &runs,
            &[&other_dir, &before, &after, &other_agent],
            T0 + HOUR_MS,
        );
        assert!(got.is_empty());
    }

    #[test]
    fn a_run_without_a_worktree_or_start_has_no_usage() {
        let autos = [automation("a", "claude")];
        let runs = [
            run(
                "r1",
                "a",
                RunStatus::DispatchFailed,
                Some(T0),
                Some(T0 + MIN),
                None,
            ),
            run("r2", "a", RunStatus::Pending, None, None, Some("/w/one")),
        ];
        let s = session("s", Agent::Claude, "/w/one", T0, T0 + MIN, 1, 1);
        assert!(join(&autos, &runs, &[&s], T0 + HOUR_MS).is_empty());
    }

    #[test]
    fn a_session_that_fits_two_runs_is_given_to_neither() {
        let autos = [automation("a", "claude")];
        let runs = [
            run(
                "r1",
                "a",
                RunStatus::Completed,
                Some(T0),
                Some(T0 + 10 * MIN),
                Some("/w"),
            ),
            run(
                "r2",
                "a",
                RunStatus::Completed,
                Some(T0 + 20 * MIN),
                Some(T0 + 30 * MIN),
                Some("/w"),
            ),
        ];
        let long = session("long", Agent::Claude, "/w", T0, T0 + 25 * MIN, 9, 9);
        let own = session(
            "own",
            Agent::Claude,
            "/w",
            T0 + 21 * MIN,
            T0 + 22 * MIN,
            5,
            5,
        );
        // `long` overlaps r1 and r2; `own` only r2, so r2 keeps `own` and r1 has nothing.
        let got = join(&autos, &runs, &[&long, &own], T0 + HOUR_MS);
        assert!(!got.contains_key("r1"));
        assert_eq!(got["r2"].tokens_in, 5);
    }

    #[test]
    fn an_open_run_reaches_up_to_now() {
        let autos = [automation("a", "claude")];
        let runs = [run(
            "r1",
            "a",
            RunStatus::Dispatched,
            Some(T0),
            None,
            Some("/w"),
        )];
        let s = session("s", Agent::Claude, "/w", T0 + 30 * MIN, T0 + 31 * MIN, 1, 2);
        assert!(join(&autos, &runs, &[&s], T0 + 40 * MIN).contains_key("r1"));
        assert!(join(&autos, &runs, &[&s], T0 + 20 * MIN).is_empty());
    }

    #[test]
    fn several_sessions_of_one_run_add_up() {
        let autos = [automation("a", "claude")];
        let runs = [run(
            "r1",
            "a",
            RunStatus::Completed,
            Some(T0),
            Some(T0 + 10 * MIN),
            Some("/w"),
        )];
        let s1 = session("s1", Agent::Claude, "/w", T0, T0 + MIN, 10, 1);
        let s2 = session("s2", Agent::Claude, "/w", T0 + 2 * MIN, T0 + 3 * MIN, 20, 2);
        let u = join(&autos, &runs, &[&s1, &s2], T0 + HOUR_MS)["r1"];
        assert_eq!((u.tokens_in, u.tokens_out), (30, 3));
        assert!(u.cost.priced);
    }

    #[test]
    fn an_unpriced_model_is_marked_not_guessed() {
        let autos = [automation("a", "claude")];
        let runs = [run(
            "r1",
            "a",
            RunStatus::Completed,
            Some(T0),
            Some(T0 + MIN),
            Some("/w"),
        )];
        let mut s = session("s", Agent::Claude, "/w", T0, T0 + 1, 10, 1);
        s.model = Some("no-such-model".into());
        let u = join(&autos, &runs, &[&s], T0 + HOUR_MS)["r1"];
        assert!(!u.cost.priced && u.cost.unpriced);
    }

    #[test]
    fn the_summary_filters_by_range_sorts_and_totals() {
        let now = T0 + 40 * DAY_MS;
        let autos = [automation("a", "claude"), automation("b", "codex")];
        let runs = [
            run(
                "old",
                "a",
                RunStatus::Completed,
                Some(now - 10 * DAY_MS),
                Some(now - 10 * DAY_MS + MIN),
                Some("/w/old"),
            ),
            run(
                "ok",
                "a",
                RunStatus::Completed,
                Some(now - 2 * HOUR_MS),
                Some(now - 2 * HOUR_MS + 5 * MIN),
                Some("/w/a"),
            ),
            run(
                "bad",
                "b",
                RunStatus::DispatchFailed,
                Some(now - HOUR_MS),
                Some(now - HOUR_MS + 1000),
                None,
            ),
            run("skip", "b", RunStatus::SkippedPrecheck, None, None, None),
            run(
                "gone",
                "zzz",
                RunStatus::Completed,
                Some(now - HOUR_MS),
                None,
                None,
            ),
        ];
        let s = session(
            "s",
            Agent::Claude,
            "/w/a",
            now - 2 * HOUR_MS,
            now - 2 * HOUR_MS + MIN,
            1000,
            500,
        );
        let week = summarize(&autos, &runs, &[&s], RunsRange::Week, now);
        let ids: Vec<&str> = week.runs.iter().map(|r| r.run_id.as_str()).collect();
        assert_eq!(ids, ["bad", "ok"]);
        assert_eq!(week.runs[1].duration_ms, Some(5 * MIN));
        assert!(week.runs[0].usage.is_none() && week.runs[1].usage.is_some());
        assert_eq!(
            (
                week.totals.runs,
                week.totals.ok,
                week.totals.failed,
                week.totals.with_usage
            ),
            (2, 1, 1, 1)
        );
        assert_eq!(week.totals.tokens, 1500);
        assert_eq!(week.by_automation.len(), 2);
        assert_eq!(week.by_automation[0].totals.tokens, 1500);
        assert_eq!(week.by_automation[1].totals.with_usage, 0);

        let month = summarize(&autos, &runs, &[&s], RunsRange::Month, now);
        assert_eq!(month.totals.runs, 3);
        let day = summarize(&autos, &runs, &[&s], RunsRange::Day, now);
        assert_eq!(day.totals.runs, 2);
        let none = summarize(&autos, &[], &[], RunsRange::Week, now);
        assert_eq!(none.totals, RunTotals::default());
    }

    #[test]
    fn the_range_reads_and_defaults() {
        assert_eq!(
            serde_json::from_str::<RunsRange>("\"24h\"").unwrap(),
            RunsRange::Day
        );
        assert_eq!(
            serde_json::from_str::<RunsRange>("\"30d\"").unwrap(),
            RunsRange::Month
        );
        assert_eq!(RunsRange::default(), RunsRange::Week);
        assert!(serde_json::from_str::<RunsRange>("\"1y\"").is_err());
    }
}
