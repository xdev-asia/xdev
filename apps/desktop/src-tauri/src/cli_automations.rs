//! `automation.list | show | run | runs | enable | disable | remove`: the
//! scheduled agent runs of the app, over the same service the Automations
//! page uses. Writes pass the policy gate like the worktree writes do.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{Value, json};
use xdev_automations::{Automation, WorkspaceMode};

use crate::cli_verbs::{Ctx, bad_request, params};
use crate::endpoint::{AppError, Caller, Request, scope_of};

/// The most runs one `automation.runs` gives.
pub const RUNS_MAX: usize = 200;
const RUNS_DEFAULT: usize = 10;

#[derive(Deserialize)]
struct IdParams {
    id: String,
}

#[derive(Deserialize)]
struct RunsParams {
    id: String,
    limit: Option<usize>,
}

/// The automation `text` names: its id, its exact name, or a unique prefix
/// of an id.
fn find(all: &[Automation], text: &str) -> Result<Automation, AppError> {
    if text.trim().is_empty() {
        return Err(bad_request("name an automation: give its id or name"));
    }
    if let Some(a) = all.iter().find(|a| a.id == text) {
        return Ok(a.clone());
    }
    let named: Vec<&Automation> = all.iter().filter(|a| a.name == text).collect();
    let prefixed: Vec<&Automation> = all.iter().filter(|a| a.id.starts_with(text)).collect();
    let found = if named.is_empty() { prefixed } else { named };
    match found.as_slice() {
        [] => Err(AppError::new("not_found", format!("no automation {text}"))),
        [one] => Ok((*one).clone()),
        _ => Err(AppError::new(
            "ambiguous",
            format!("more than one automation is {text}"),
        )),
    }
}

/// The automation as the verbs print it: its fields and its newest run.
fn view(a: &Automation, last_run: Option<&Value>) -> Value {
    let mut v = serde_json::to_value(a).unwrap_or(Value::Null);
    v["lastRun"] = last_run.cloned().unwrap_or(Value::Null);
    v
}

fn newest(ctx: &Ctx<'_>, id: &str) -> Option<Value> {
    ctx.automations
        .get_runs(id)
        .first()
        .and_then(|r| serde_json::to_value(r).ok())
}

/// The folder a write on `a` touches: its worktree, else its repo.
fn target_of(ctx: &Ctx<'_>, a: &Automation) -> Result<PathBuf, AppError> {
    if a.workspace_mode == WorkspaceMode::Existing
        && let Some(w) = &a.worktree
    {
        return Ok(PathBuf::from(w));
    }
    let reg = ctx.registry()?;
    Ok(reg
        .repos
        .iter()
        .find(|r| r.id == a.repo_id)
        .map(|r| r.path.clone())
        .unwrap_or_else(|| ctx.data.to_owned()))
}

/// The gate of a write: the caller's own worktree passes, anything else asks.
fn gate(
    ctx: &Ctx<'_>,
    caller: &Caller,
    verb: &str,
    op: &str,
    a: &Automation,
) -> Result<(), AppError> {
    let me = ctx.caller_worktree(caller)?;
    let target = target_of(ctx, a)?;
    let scope = scope_of(me.as_deref(), &target, &ctx.registry()?);
    ctx.gate(verb, op, me.as_deref().map(Path::new), &target, scope)
}

pub fn handle(ctx: &Ctx<'_>, req: &Request, caller: &Caller) -> Result<Value, AppError> {
    let all = || ctx.automations.list();
    match req.method.as_str() {
        "automation.list" => {
            let v = all();
            let rows: Vec<Value> = v
                .automations
                .iter()
                .map(|a| {
                    let last = v
                        .last_runs
                        .iter()
                        .find(|r| r.automation_id == a.id)
                        .and_then(|r| serde_json::to_value(r).ok());
                    view(a, last.as_ref())
                })
                .collect();
            Ok(Value::Array(rows))
        }
        "automation.show" => {
            let p: IdParams = params(req)?;
            let a = find(&all().automations, &p.id)?;
            Ok(view(&a, newest(ctx, &a.id).as_ref()))
        }
        "automation.runs" => {
            let p: RunsParams = params(req)?;
            let limit = p.limit.unwrap_or(RUNS_DEFAULT);
            if !(1..=RUNS_MAX).contains(&limit) {
                return Err(bad_request(format!("limit is 1 to {RUNS_MAX}")));
            }
            let a = find(&all().automations, &p.id)?;
            let runs: Vec<Value> = ctx
                .automations
                .get_runs(&a.id)
                .iter()
                .take(limit)
                .filter_map(|r| serde_json::to_value(r).ok())
                .collect();
            Ok(Value::Array(runs))
        }
        "automation.run" => {
            let p: IdParams = params(req)?;
            let a = find(&all().automations, &p.id)?;
            gate(ctx, caller, "automation.run", "run", &a)?;
            let run = ctx.automations.run_now(&a.id)?;
            (ctx.announce)(Some(&a.id));
            Ok(serde_json::to_value(run).unwrap_or(Value::Null))
        }
        "automation.enable" | "automation.disable" => {
            let on = req.method == "automation.enable";
            let p: IdParams = params(req)?;
            let a = find(&all().automations, &p.id)?;
            let op = if on { "enable" } else { "disable" };
            gate(ctx, caller, &req.method, op, &a)?;
            let made = ctx.automations.set_enabled(&a.id, on)?;
            (ctx.announce)(Some(&a.id));
            Ok(view(&made, newest(ctx, &a.id).as_ref()))
        }
        "automation.remove" => {
            let p: IdParams = params(req)?;
            let a = find(&all().automations, &p.id)?;
            gate(ctx, caller, "automation.remove", "remove", &a)?;
            ctx.automations.delete(&a.id)?;
            (ctx.announce)(Some(&a.id));
            Ok(json!({ "id": a.id }))
        }
        other => Err(bad_request(format!("unknown method {other}"))),
    }
}

#[cfg(test)]
mod tests {
    use xdev_automations::{AutomationInput, SetupDecision};

    use super::*;
    use crate::cli_verbs::tests::{Fixture, fixture};

    fn input(name: &str, worktree: &Path) -> AutomationInput {
        AutomationInput {
            name: name.into(),
            prompt: "Look around.".into(),
            precheck: None,
            agent: "claude".into(),
            extra_agent_args: None,
            repo_id: "repo".into(),
            workspace_mode: WorkspaceMode::Existing,
            worktree: Some(worktree.display().to_string()),
            base_branch: None,
            setup_decision: SetupDecision::Inherit,
            reuse_session: false,
            timezone: "UTC".into(),
            rrule: "FREQ=HOURLY;BYMINUTE=0".into(),
            dtstart: 0,
            enabled: true,
            missed_run_grace_minutes: 720,
        }
    }

    fn make(f: &Fixture, name: &str, worktree: &Path) -> String {
        f.automations.create(input(name, worktree)).unwrap().id
    }

    #[test]
    fn list_show_and_runs_read_the_store() {
        let f = fixture();
        let id = make(&f, "Nightly", &f.lead);
        make(&f, "Weekly", &f.other);
        let list = f.call(None, "automation.list", Value::Null).unwrap();
        let names: Vec<&str> = list
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a["name"].as_str().unwrap())
            .collect();
        assert_eq!(names.len(), 2);
        assert!(names.contains(&"Nightly") && names.contains(&"Weekly"));
        assert!(list[0]["lastRun"].is_null());
        // By id, by name, and by a unique prefix.
        for text in [id.as_str(), "Nightly", &id[..8]] {
            let r = f
                .call(None, "automation.show", json!({ "id": text }))
                .unwrap();
            assert_eq!(r["id"], id.as_str(), "{text}");
            assert_eq!(r["rrule"], "FREQ=HOURLY;BYMINUTE=0");
        }
        assert_eq!(
            f.call(None, "automation.runs", json!({ "id": "Nightly" }))
                .unwrap(),
            json!([])
        );
        // Reads never ask and never announce.
        assert!(f.announced.lock().unwrap().is_empty());
        assert!(f.events.lock().unwrap().is_empty());
    }

    #[test]
    fn an_unknown_or_ambiguous_id_is_an_error() {
        let f = fixture();
        make(&f, "Same", &f.lead);
        make(&f, "Same", &f.other);
        let e = |id: &str| {
            f.call(None, "automation.show", json!({ "id": id }))
                .unwrap_err()
        };
        assert_eq!(e("nope").code, "not_found");
        assert_eq!(e("Same").code, "ambiguous");
        assert_eq!(e("").code, "bad_request");
    }

    #[test]
    fn run_queues_a_manual_run_as_run_now_does_and_announces() {
        let f = fixture();
        let id = make(&f, "Nightly", &f.lead);
        let r = f
            .call(Some("p-lead"), "automation.run", json!({ "id": "Nightly" }))
            .unwrap();
        assert_eq!(r["automationId"], id.as_str());
        assert_eq!(r["trigger"], "manual");
        assert_eq!(r["runNumber"], 1);
        assert_eq!(f.announced.lock().unwrap().as_slice(), [Some(id.clone())]);
        let runs = f
            .call(None, "automation.runs", json!({ "id": id, "limit": 5 }))
            .unwrap();
        assert_eq!(runs.as_array().unwrap().len(), 1);
        assert_eq!(runs[0]["id"], r["id"]);
        // A run in flight blocks the next one, as in the UI.
        let e = f
            .call(Some("p-lead"), "automation.run", json!({ "id": id }))
            .unwrap_err();
        assert_eq!(e.code, "bad_arg");
        let list = f.call(None, "automation.list", Value::Null).unwrap();
        assert_eq!(list[0]["lastRun"]["id"], r["id"]);
    }

    #[test]
    fn runs_are_limited() {
        let f = fixture();
        let id = make(&f, "Nightly", &f.lead);
        f.call(Some("p-lead"), "automation.run", json!({ "id": id }))
            .unwrap();
        for bad in [0, 201] {
            let e = f
                .call(None, "automation.runs", json!({ "id": id, "limit": bad }))
                .unwrap_err();
            assert_eq!(e.code, "bad_request", "{bad}");
        }
    }

    #[test]
    fn enable_and_disable_flip_the_schedule() {
        let f = fixture();
        let id = make(&f, "Nightly", &f.lead);
        let r = f
            .call(Some("p-lead"), "automation.disable", json!({ "id": id }))
            .unwrap();
        assert_eq!(r["enabled"], false);
        assert!(!f.automations.list().automations[0].enabled);
        let r = f
            .call(Some("p-lead"), "automation.enable", json!({ "id": id }))
            .unwrap();
        assert_eq!(r["enabled"], true);
        assert_eq!(f.announced.lock().unwrap().len(), 2);
    }

    #[test]
    fn remove_deletes_the_automation_and_announces() {
        let f = fixture();
        let id = make(&f, "Nightly", &f.lead);
        let r = f
            .call(Some("p-lead"), "automation.remove", json!({ "id": id }))
            .unwrap();
        assert_eq!(r, json!({ "id": id }));
        assert!(f.automations.list().automations.is_empty());
        assert_eq!(f.announced.lock().unwrap().as_slice(), [Some(id)]);
    }

    #[test]
    fn writes_on_another_worktree_ask_the_person() {
        let mut f = fixture();
        let id = make(&f, "Nightly", &f.other);
        // From the lead's terminal the target is `other`: nobody answers.
        let e = f
            .call(Some("p-lead"), "automation.disable", json!({ "id": id }))
            .unwrap_err();
        assert_eq!(e.code, "needs_approval");
        assert!(f.automations.list().automations[0].enabled);
        // The person says no.
        f.answer = Some(false);
        let e = f
            .call(Some("p-lead"), "automation.remove", json!({ "id": id }))
            .unwrap_err();
        assert_eq!(e.code, "denied");
        assert_eq!(f.automations.list().automations.len(), 1);
        // The person says yes; a script outside asks the same way.
        f.answer = Some(true);
        f.call(None, "automation.disable", json!({ "id": id }))
            .unwrap();
        assert!(!f.automations.list().automations[0].enabled);
        let asks = f
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|(e, _)| e == "cli://ask")
            .count();
        assert_eq!(asks, 3);
    }

    #[test]
    fn an_unknown_automation_method_is_a_bad_request() {
        let f = fixture();
        let e = f.call(None, "automation.nope", Value::Null).unwrap_err();
        assert_eq!(e.code, "bad_request");
    }
}
