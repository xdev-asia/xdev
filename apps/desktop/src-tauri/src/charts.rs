//! Team charts for the chart builder: list, save, delete, duplicate, save a
//! squad as a chart, and record the tabs a run of a chart opened. The charts
//! live in the orchestration store; the window opens the tabs.

use tauri::State;
use xdev_agent::{Role, Squad};
use xdev_orch::{Chart, ChartEdge, ChartKind, ChartRun, ChartSeat, OrchError, SeatTab};

use crate::accounts::{data_dir, local_dir};
use crate::commands::{AppState, CmdError};
use crate::orchestration::OrchHub;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

fn cmd_err(e: OrchError) -> CmdError {
    CmdError {
        code: "orchestration",
        detail: Some(format!("{}: {}", e.code, e.message)),
    }
}

/// The agent a squad seat starts when its account is vacant or unknown.
const DEFAULT_AGENT: &str = "claude";

/// A squad as a hierarchy chart: its lead seat leads, every other seat with
/// an account works under it, and the lead reads each worker's transcript.
/// `provider` names the agent of an account (`claude`, `codex`).
pub(crate) fn chart_from_squad(squad: &Squad, provider: &dyn Fn(&str) -> Option<String>) -> Chart {
    let agent = |account: Option<&str>| {
        account
            .and_then(provider)
            .unwrap_or_else(|| DEFAULT_AGENT.to_owned())
    };
    let mut seats = Vec::new();
    for seat in &squad.seats {
        if seat.role != Role::Lead && seat.account.is_none() {
            continue;
        }
        seats.push(ChartSeat {
            id: seat.role.as_str().to_owned(),
            role: seat.role.as_str().to_owned(),
            agent: agent(seat.account.as_deref()),
            model: None,
            prompt: String::new(),
            lead: seat.role == Role::Lead,
        });
    }
    let lead = Role::Lead.as_str();
    let edges = seats
        .iter()
        .filter(|s| !s.lead)
        .map(|s| ChartEdge {
            from: lead.to_owned(),
            to: s.id.clone(),
            transcript: true,
            screen: false,
        })
        .collect();
    Chart {
        id: String::new(),
        name: squad.name.clone(),
        kind: ChartKind::Hierarchy,
        seats,
        edges,
        routes: Vec::new(),
        created_ms: 0,
        updated_ms: 0,
    }
}

/// Every saved chart, oldest first.
#[tauri::command(async)]
pub fn charts_list(
    state: State<'_, AppState>,
    hub: State<'_, OrchHub>,
) -> Result<Vec<Chart>, CmdError> {
    let data = data_dir(&state)?;
    hub.with_store(data, |s| s.chart_list()).map_err(cmd_err)
}

/// Saves a chart once it is valid; an empty id makes a new one. Rejects
/// `invalid_chart: <problem>`.
#[tauri::command(async)]
pub fn charts_save(
    state: State<'_, AppState>,
    hub: State<'_, OrchHub>,
    chart: Chart,
) -> Result<Chart, CmdError> {
    let data = data_dir(&state)?;
    hub.with_store(data, |s| s.chart_save(chart, now_ms()))
        .map_err(cmd_err)
}

/// Removes a chart; false when there was none.
#[tauri::command(async)]
pub fn charts_delete(
    state: State<'_, AppState>,
    hub: State<'_, OrchHub>,
    id: String,
) -> Result<bool, CmdError> {
    let data = data_dir(&state)?;
    hub.with_store(data, |s| s.chart_delete(&id))
        .map_err(cmd_err)
}

/// Saves a copy of a chart under `name`.
#[tauri::command(async)]
pub fn charts_duplicate(
    state: State<'_, AppState>,
    hub: State<'_, OrchHub>,
    id: String,
    name: String,
) -> Result<Chart, CmdError> {
    let data = data_dir(&state)?;
    hub.with_store(data, |s| s.chart_duplicate(&id, &name, now_ms()))
        .map_err(cmd_err)
}

/// Saves the squad `id` as a hierarchy chart: its seats with an account,
/// under its lead.
#[tauri::command(async)]
pub fn charts_save_squad(
    state: State<'_, AppState>,
    hub: State<'_, OrchHub>,
    id: String,
) -> Result<Chart, CmdError> {
    let data = data_dir(&state)?;
    let squad = xdev_agent::SquadStore::with_local(data, local_dir(&state)?).load(&id)?;
    let reg = xdev_ai::Registry::load(data)?;
    let provider = |account: &str| {
        reg.get(account)
            .and_then(|e| serde_json::to_value(e.provider).ok())
            .and_then(|v| v.as_str().map(str::to_owned))
    };
    let chart = chart_from_squad(&squad, &provider);
    hub.with_store(data, |s| s.chart_save(chart, now_ms()))
        .map_err(cmd_err)
}

/// Records the tabs the window opened for a run of chart `id`, one per
/// seat, and links them along the chart's edges.
#[tauri::command(async)]
pub fn charts_run_bind(
    state: State<'_, AppState>,
    hub: State<'_, OrchHub>,
    id: String,
    tabs: Vec<SeatTab>,
) -> Result<ChartRun, CmdError> {
    let data = data_dir(&state)?;
    hub.with_store(data, |s| s.chart_run_bind(&id, &tabs, now_ms()))
        .map_err(cmd_err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use xdev_agent::Seat;

    fn squad(accounts: [Option<&str>; 4]) -> Squad {
        let seats = [Role::Lead, Role::Implement, Role::Tests, Role::Review]
            .into_iter()
            .zip(accounts)
            .map(|(role, a)| Seat {
                role,
                account: a.map(str::to_owned),
            })
            .collect::<Vec<_>>();
        Squad {
            id: "sq_1".into(),
            name: "Ship it".into(),
            repo: "/repo".into(),
            seats: seats.try_into().unwrap(),
            test: None,
            created: 1,
        }
    }

    fn provider(account: &str) -> Option<String> {
        match account {
            "work" => Some("codex".into()),
            "home" => Some("claude".into()),
            _ => None,
        }
    }

    #[test]
    fn a_squad_saves_as_a_valid_hierarchy_under_its_lead() {
        let c = chart_from_squad(
            &squad([Some("home"), Some("work"), None, Some("home")]),
            &provider,
        );
        assert_eq!(c.name, "Ship it");
        assert_eq!(c.kind, ChartKind::Hierarchy);
        let seats: Vec<_> = c
            .seats
            .iter()
            .map(|s| (s.id.as_str(), s.agent.as_str(), s.lead))
            .collect();
        assert_eq!(
            seats,
            [
                ("lead", "claude", true),
                ("implement", "codex", false),
                ("review", "claude", false)
            ]
        );
        let edges: Vec<_> = c
            .edges
            .iter()
            .map(|e| (e.from.as_str(), e.to.as_str()))
            .collect();
        assert_eq!(edges, [("lead", "implement"), ("lead", "review")]);
        assert!(xdev_orch::charts::problems(&c).is_empty());
        let s = xdev_orch::Store::open_in_memory().unwrap();
        let saved = s.chart_save(c, 5).unwrap();
        assert_eq!(s.chart_list().unwrap(), [saved]);
    }

    #[test]
    fn a_vacant_lead_still_leads_on_the_default_agent() {
        let c = chart_from_squad(&squad([None, Some("gone"), None, None]), &provider);
        assert_eq!(c.seats.len(), 2);
        assert_eq!(c.seats[0].agent, DEFAULT_AGENT);
        assert_eq!(c.seats[1].agent, DEFAULT_AGENT);
        assert!(xdev_orch::charts::problems(&c).is_empty());
    }
}
