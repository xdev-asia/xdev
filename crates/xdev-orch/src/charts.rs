//! Team charts: a saved team shape (seats and the edges between them) that
//! can be run again. A chart is one of three kinds: a hierarchy (one lead,
//! workers under it), a pipeline (ordered stages, no cycle) or a router (a
//! dispatcher that sends work to seats by kind).
//!
//! A run of a chart puts each seat in a tab. The tabs it made are kept as
//! members of the run, so the hierarchy rule can be checked where hand-offs
//! and mail are decided: a worker of a hierarchy talks to its lead only.

use std::collections::{HashMap, HashSet};

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::error::OrchError;
use crate::links::{Grant, TabLink};
use crate::store::{Store, enum_from, enum_text};

/// The most seats a chart has.
pub const SEATS_MAX: usize = 16;
/// The longest chart name, in characters.
pub const NAME_MAX: usize = 80;
/// The longest seat prompt, in bytes.
pub const PROMPT_MAX: usize = 8 * 1024;

/// The shape of a team.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum ChartKind {
    /// One lead with workers under it.
    Hierarchy,
    /// Ordered stages; the edges must not loop.
    Pipeline,
    /// A dispatcher sends work to seats by kind.
    Router,
}

/// One place in a team.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ChartSeat {
    /// Unique within the chart; edges and routes name seats by it.
    pub id: String,
    /// What the seat does, in the person's words.
    pub role: String,
    /// The agent profile the seat starts (`claude`, `codex`, ...).
    pub agent: String,
    /// The model to start on; none keeps the profile's.
    pub model: Option<String>,
    /// The first prompt the seat is given.
    pub prompt: String,
    /// The lead of a hierarchy, or the dispatcher of a router. A pipeline
    /// keeps the flag but does not use it.
    pub lead: bool,
}

/// `from` may read `to`, through the grants that are on. A run makes one
/// tab link per edge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ChartEdge {
    pub from: String,
    pub to: String,
    pub transcript: bool,
    pub screen: bool,
}

/// One row of a router's match table: work of `kind` goes to `seat`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ChartRoute {
    pub kind: String,
    pub seat: String,
}

/// A saved team shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Chart {
    /// Empty for a chart that was never saved.
    pub id: String,
    pub name: String,
    pub kind: ChartKind,
    /// In order: a pipeline's stages run in this order.
    pub seats: Vec<ChartSeat>,
    pub edges: Vec<ChartEdge>,
    /// A router's match table; the other kinds keep it but do not use it.
    pub routes: Vec<ChartRoute>,
    pub created_ms: i64,
    pub updated_ms: i64,
}

/// Why a chart cannot be saved or run. The UI words each one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum ChartProblem {
    NoName,
    NameTooLong,
    NoSeats,
    TooManySeats,
    SeatIdTaken,
    NoAgent,
    PromptTooLong,
    /// An edge or a route names a seat the chart does not have.
    UnknownSeat,
    SelfEdge,
    /// A hierarchy without a lead, or a router without a dispatcher.
    NoLead,
    /// A hierarchy with two leads or more, or a router with two dispatchers.
    TooManyLeads,
    PipelineCycle,
    /// A router without a match table entry.
    NoRoute,
    /// A route with a blank kind.
    BlankRoute,
}

impl ChartProblem {
    /// The serde name, as the error detail carries it.
    pub fn code(self) -> String {
        enum_text(&self)
    }
}

/// Whether the edges between `seats` loop back on themselves.
fn has_cycle(seats: &[ChartSeat], edges: &[ChartEdge]) -> bool {
    let mut into: HashMap<&str, usize> = seats.iter().map(|s| (s.id.as_str(), 0)).collect();
    let mut out: HashMap<&str, Vec<&str>> = HashMap::new();
    for e in edges {
        if let Some(n) = into.get_mut(e.to.as_str()) {
            *n += 1;
        }
        out.entry(e.from.as_str()).or_default().push(e.to.as_str());
    }
    let mut ready: Vec<&str> = into
        .iter()
        .filter(|(_, n)| **n == 0)
        .map(|(id, _)| *id)
        .collect();
    let mut seen = 0;
    while let Some(id) = ready.pop() {
        seen += 1;
        for to in out.get(id).into_iter().flatten() {
            if let Some(n) = into.get_mut(to) {
                *n -= 1;
                if *n == 0 {
                    ready.push(to);
                }
            }
        }
    }
    seen < into.len()
}

/// Every problem of `chart`, in a fixed order; empty when it may be saved.
pub fn problems(chart: &Chart) -> Vec<ChartProblem> {
    use ChartProblem as P;
    let mut out = Vec::new();
    let name = chart.name.trim();
    if name.is_empty() {
        out.push(P::NoName);
    } else if name.chars().count() > NAME_MAX {
        out.push(P::NameTooLong);
    }
    if chart.seats.is_empty() {
        out.push(P::NoSeats);
    }
    if chart.seats.len() > SEATS_MAX {
        out.push(P::TooManySeats);
    }
    let mut ids = HashSet::new();
    if chart
        .seats
        .iter()
        .any(|s| s.id.trim().is_empty() || !ids.insert(s.id.as_str()))
    {
        out.push(P::SeatIdTaken);
    }
    if chart.seats.iter().any(|s| s.agent.trim().is_empty()) {
        out.push(P::NoAgent);
    }
    if chart.seats.iter().any(|s| s.prompt.len() > PROMPT_MAX) {
        out.push(P::PromptTooLong);
    }
    let known = |id: &str| ids.contains(id);
    let unknown_edge = chart.edges.iter().any(|e| !known(&e.from) || !known(&e.to));
    let unknown_route =
        chart.kind == ChartKind::Router && chart.routes.iter().any(|r| !known(&r.seat));
    if unknown_edge || unknown_route {
        out.push(P::UnknownSeat);
    }
    if chart.edges.iter().any(|e| e.from == e.to) {
        out.push(P::SelfEdge);
    }
    let leads = chart.seats.iter().filter(|s| s.lead).count();
    match chart.kind {
        ChartKind::Hierarchy | ChartKind::Router if !chart.seats.is_empty() => {
            if leads == 0 {
                out.push(P::NoLead);
            } else if leads > 1 {
                out.push(P::TooManyLeads);
            }
        }
        _ => {}
    }
    match chart.kind {
        ChartKind::Pipeline if !unknown_edge && has_cycle(&chart.seats, &chart.edges) => {
            out.push(P::PipelineCycle);
        }
        ChartKind::Router => {
            if chart.routes.is_empty() {
                out.push(P::NoRoute);
            } else if chart.routes.iter().any(|r| r.kind.trim().is_empty()) {
                out.push(P::BlankRoute);
            }
        }
        _ => {}
    }
    out
}

/// The first problem of `chart`, as the error a save answers.
pub fn validate(chart: &Chart) -> Result<(), OrchError> {
    match problems(chart).first() {
        None => Ok(()),
        Some(p) => Err(OrchError::new("invalid_chart", p.code())),
    }
}

/// The edges a pipeline's seats get when it has none: each stage reads the one before it.
pub fn pipeline_edges(seats: &[ChartSeat]) -> Vec<ChartEdge> {
    seats
        .windows(2)
        .map(|w| ChartEdge {
            from: w[1].id.clone(),
            to: w[0].id.clone(),
            transcript: true,
            screen: false,
        })
        .collect()
}

/// A tab a run of a chart opened for one seat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SeatTab {
    pub seat: String,
    pub tab: String,
}

/// A tab in a run of a chart, and where it sits in the team.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ChartMember {
    pub tab: String,
    pub run_id: String,
    pub chart_id: String,
    pub seat: String,
    pub kind: ChartKind,
    /// The lead's tab, for a worker of a hierarchy; none for anyone else.
    pub lead_tab: Option<String>,
}

impl ChartMember {
    /// A worker of a hierarchy: it talks to its lead only.
    pub fn is_hierarchy_worker(&self) -> bool {
        self.kind == ChartKind::Hierarchy && self.lead_tab.is_some()
    }
}

/// What a run of a chart made: its members, one per seat, and the links.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ChartRun {
    pub run_id: String,
    pub chart_id: String,
    pub members: Vec<ChartMember>,
    pub links: Vec<TabLink>,
}

/// The hierarchy rule for a hand-off: a worker of a hierarchy hands off to
/// its lead's tab and nowhere else. Anyone else is not held by it.
pub fn may_hand_off(sender: Option<&ChartMember>, to_tab: &str) -> bool {
    match sender {
        Some(m) if m.is_hierarchy_worker() => m.lead_tab.as_deref() == Some(to_tab),
        _ => true,
    }
}

/// The hierarchy rule for mail: a worker of a hierarchy may not write to
/// another seat of its run other than the lead. Mail that stays outside the
/// team (to the workers of its own run, say) is not held by it.
pub fn may_mail(sender: Option<&ChartMember>, recipient: Option<&ChartMember>) -> bool {
    match (sender, recipient) {
        (Some(s), Some(r)) if s.is_hierarchy_worker() && r.run_id == s.run_id => {
            s.lead_tab.as_deref() == Some(r.tab.as_str())
        }
        _ => true,
    }
}

/// The refusal both rules answer.
pub(crate) fn hierarchy_denied() -> OrchError {
    OrchError::new("denied", "a worker in a hierarchy talks to its lead only")
}

#[derive(Serialize, Deserialize)]
struct Body {
    seats: Vec<ChartSeat>,
    edges: Vec<ChartEdge>,
    #[serde(default)]
    routes: Vec<ChartRoute>,
}

const CHART_COLS: &str = "id, name, kind, body, created_ms, updated_ms";

fn chart_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Chart> {
    let conv = |idx: usize, e: OrchError| {
        rusqlite::Error::FromSqlConversionFailure(idx, rusqlite::types::Type::Text, Box::new(e))
    };
    let kind: String = r.get(2)?;
    let body: String = r.get(3)?;
    let body: Body = serde_json::from_str(&body).map_err(|e| conv(3, e.into()))?;
    Ok(Chart {
        id: r.get(0)?,
        name: r.get(1)?,
        kind: enum_from(&kind).map_err(|e| conv(2, e))?,
        seats: body.seats,
        edges: body.edges,
        routes: body.routes,
        created_ms: r.get(4)?,
        updated_ms: r.get(5)?,
    })
}

const MEMBER_COLS: &str = "tab, run_id, chart_id, seat_id, kind, lead_tab";

fn member_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ChartMember> {
    let kind: String = r.get(4)?;
    Ok(ChartMember {
        tab: r.get(0)?,
        run_id: r.get(1)?,
        chart_id: r.get(2)?,
        seat: r.get(3)?,
        kind: enum_from(&kind).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(e))
        })?,
        lead_tab: r.get(5)?,
    })
}

impl Store {
    /// Every chart, oldest first.
    pub fn chart_list(&self) -> Result<Vec<Chart>, OrchError> {
        let mut st = self.conn.prepare(&format!(
            "SELECT {CHART_COLS} FROM charts ORDER BY created_ms, rowid"
        ))?;
        Ok(st
            .query_map([], chart_row)?
            .collect::<Result<Vec<_>, _>>()?)
    }

    /// The chart `id`, if there is one.
    pub fn chart_get(&self, id: &str) -> Result<Option<Chart>, OrchError> {
        Ok(self
            .conn
            .query_row(
                &format!("SELECT {CHART_COLS} FROM charts WHERE id = ?1"),
                [id],
                chart_row,
            )
            .optional()?)
    }

    fn chart_must(&self, id: &str) -> Result<Chart, OrchError> {
        self.chart_get(id)?
            .ok_or_else(|| OrchError::not_found(format!("no chart {id}")))
    }

    /// Saves `chart` once it is valid. An empty or unknown id makes a new
    /// chart; a known one replaces it and keeps when it was made.
    pub fn chart_save(&self, chart: Chart, now_ms: i64) -> Result<Chart, OrchError> {
        let mut chart = chart;
        chart.name = chart.name.trim().to_owned();
        validate(&chart)?;
        let body = serde_json::to_string(&Body {
            seats: chart.seats.clone(),
            edges: chart.edges.clone(),
            routes: chart.routes.clone(),
        })?;
        let old = if chart.id.is_empty() {
            None
        } else {
            self.chart_get(&chart.id)?
        };
        match old {
            Some(old) => {
                self.conn.execute(
                    "UPDATE charts SET name = ?2, kind = ?3, body = ?4, updated_ms = ?5 WHERE id = ?1",
                    params![chart.id, chart.name, enum_text(&chart.kind), body, now_ms],
                )?;
                chart.created_ms = old.created_ms;
            }
            None => {
                if chart.id.is_empty() {
                    chart.id = self.next_id("chart");
                }
                self.conn.execute(
                    "INSERT INTO charts (id, name, kind, body, created_ms, updated_ms)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                    params![chart.id, chart.name, enum_text(&chart.kind), body, now_ms],
                )?;
                chart.created_ms = now_ms;
            }
        }
        chart.updated_ms = now_ms;
        Ok(chart)
    }

    /// Removes the chart `id`; false when there was none.
    pub fn chart_delete(&self, id: &str) -> Result<bool, OrchError> {
        Ok(self
            .conn
            .execute("DELETE FROM charts WHERE id = ?1", [id])?
            > 0)
    }

    /// A copy of the chart `id` under `name`, saved as a new chart.
    pub fn chart_duplicate(&self, id: &str, name: &str, now_ms: i64) -> Result<Chart, OrchError> {
        let mut copy = self.chart_must(id)?;
        copy.id = String::new();
        copy.name = name.chars().take(NAME_MAX).collect();
        self.chart_save(copy, now_ms)
    }

    /// Records the tabs a run of chart `id` opened, one per seat, and links
    /// them along the chart's edges with the edges' grants.
    pub fn chart_run_bind(
        &self,
        id: &str,
        tabs: &[SeatTab],
        now_ms: i64,
    ) -> Result<ChartRun, OrchError> {
        let chart = self.chart_must(id)?;
        validate(&chart)?;
        let mut tab_of: HashMap<&str, &str> = HashMap::new();
        let mut used = HashSet::new();
        for t in tabs {
            if t.tab.trim().is_empty() || !used.insert(t.tab.as_str()) {
                return Err(OrchError::bad_request("each seat needs a tab of its own"));
            }
            if !chart.seats.iter().any(|s| s.id == t.seat) {
                return Err(OrchError::bad_request(format!("no seat {}", t.seat)));
            }
            tab_of.insert(t.seat.as_str(), t.tab.as_str());
        }
        if let Some(s) = chart
            .seats
            .iter()
            .find(|s| !tab_of.contains_key(s.id.as_str()))
        {
            return Err(OrchError::bad_request(format!("seat {} has no tab", s.id)));
        }
        let lead_tab = match chart.kind {
            ChartKind::Hierarchy => chart
                .seats
                .iter()
                .find(|s| s.lead)
                .map(|s| tab_of[s.id.as_str()].to_owned()),
            _ => None,
        };
        let run_id = self.next_id("crun");
        self.atomic(|s| {
            let mut members = Vec::new();
            for seat in &chart.seats {
                let tab = tab_of[seat.id.as_str()].to_owned();
                let lead = if seat.lead { None } else { lead_tab.clone() };
                s.conn.execute(
                    "INSERT OR REPLACE INTO chart_tabs (tab, run_id, chart_id, seat_id, kind, lead_tab, created_ms)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![tab, run_id, chart.id, seat.id, enum_text(&chart.kind), lead, now_ms],
                )?;
                members.push(ChartMember {
                    tab,
                    run_id: run_id.clone(),
                    chart_id: chart.id.clone(),
                    seat: seat.id.clone(),
                    kind: chart.kind,
                    lead_tab: lead,
                });
            }
            let mut links = Vec::new();
            for e in &chart.edges {
                let (from, to) = (tab_of[e.from.as_str()], tab_of[e.to.as_str()]);
                s.link_put(from, to, now_ms)?;
                s.link_set_grant(from, to, Grant::Transcript, e.transcript, now_ms)?;
                links.push(s.link_set_grant(from, to, Grant::Screen, e.screen, now_ms)?);
            }
            Ok(ChartRun {
                run_id: run_id.clone(),
                chart_id: chart.id.clone(),
                members,
                links,
            })
        })
    }

    /// The run of a chart tab `tab` sits in, if any.
    pub fn chart_member(&self, tab: &str) -> Result<Option<ChartMember>, OrchError> {
        Ok(self
            .conn
            .query_row(
                &format!("SELECT {MEMBER_COLS} FROM chart_tabs WHERE tab = ?1"),
                [tab],
                member_row,
            )
            .optional()?)
    }

    /// Every tab in a run of a chart, oldest first.
    pub fn chart_members(&self) -> Result<Vec<ChartMember>, OrchError> {
        let mut st = self.conn.prepare(&format!(
            "SELECT {MEMBER_COLS} FROM chart_tabs ORDER BY created_ms, rowid"
        ))?;
        Ok(st
            .query_map([], member_row)?
            .collect::<Result<Vec<_>, _>>()?)
    }

    /// Forgets the members whose tab is no longer open; returns how many.
    pub fn chart_members_prune(&self, open: &dyn Fn(&str) -> bool) -> Result<usize, OrchError> {
        let mut gone = 0;
        for m in self.chart_members()? {
            if !open(&m.tab) {
                gone += self
                    .conn
                    .execute("DELETE FROM chart_tabs WHERE tab = ?1", [&m.tab])?;
            }
        }
        Ok(gone)
    }

    /// Refuses a hand-off from tab `from` to tab `to` that the hierarchy rule forbids.
    pub fn check_hand_off(&self, from: &str, to: &str) -> Result<(), OrchError> {
        if may_hand_off(self.chart_member(from)?.as_ref(), to) {
            Ok(())
        } else {
            Err(hierarchy_denied())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seat(id: &str, lead: bool) -> ChartSeat {
        ChartSeat {
            id: id.into(),
            role: id.into(),
            agent: "claude".into(),
            model: None,
            prompt: String::new(),
            lead,
        }
    }

    fn edge(from: &str, to: &str) -> ChartEdge {
        ChartEdge {
            from: from.into(),
            to: to.into(),
            transcript: true,
            screen: false,
        }
    }

    fn chart(kind: ChartKind, seats: Vec<ChartSeat>, edges: Vec<ChartEdge>) -> Chart {
        Chart {
            id: String::new(),
            name: "Team".into(),
            kind,
            seats,
            edges,
            routes: vec![],
            created_ms: 0,
            updated_ms: 0,
        }
    }

    fn hierarchy() -> Chart {
        chart(
            ChartKind::Hierarchy,
            vec![seat("lead", true), seat("a", false), seat("b", false)],
            vec![edge("lead", "a"), edge("lead", "b")],
        )
    }

    #[test]
    fn a_hierarchy_needs_exactly_one_lead() {
        assert!(problems(&hierarchy()).is_empty());
        let mut none = hierarchy();
        none.seats[0].lead = false;
        assert_eq!(problems(&none), [ChartProblem::NoLead]);
        let mut two = hierarchy();
        two.seats[1].lead = true;
        assert_eq!(problems(&two), [ChartProblem::TooManyLeads]);
        assert_eq!(validate(&two).unwrap_err().code, "invalid_chart");
        assert_eq!(validate(&two).unwrap_err().message, "too_many_leads");
    }

    #[test]
    fn a_pipeline_may_not_loop() {
        let seats = vec![seat("a", false), seat("b", false), seat("c", false)];
        let line = chart(ChartKind::Pipeline, seats.clone(), pipeline_edges(&seats));
        assert!(problems(&line).is_empty());
        let mut looped = line.clone();
        looped.edges.push(edge("a", "c"));
        assert_eq!(problems(&looped), [ChartProblem::PipelineCycle]);
        // A pipeline does not care about leads.
        let mut leads = line;
        leads.seats[0].lead = true;
        leads.seats[1].lead = true;
        assert!(problems(&leads).is_empty());
    }

    #[test]
    fn a_router_needs_a_match_table_entry_for_a_known_seat() {
        let mut r = chart(
            ChartKind::Router,
            vec![seat("desk", true), seat("fix", false), seat("docs", false)],
            vec![edge("desk", "fix")],
        );
        assert_eq!(problems(&r), [ChartProblem::NoRoute]);
        r.routes.push(ChartRoute {
            kind: "bug".into(),
            seat: "fix".into(),
        });
        assert!(problems(&r).is_empty());
        r.routes.push(ChartRoute {
            kind: "docs".into(),
            seat: "nobody".into(),
        });
        assert_eq!(problems(&r), [ChartProblem::UnknownSeat]);
        r.routes.pop();
        r.routes.push(ChartRoute {
            kind: " ".into(),
            seat: "docs".into(),
        });
        assert_eq!(problems(&r), [ChartProblem::BlankRoute]);
    }

    #[test]
    fn edges_must_point_at_known_seats() {
        let mut h = hierarchy();
        h.edges.push(edge("lead", "ghost"));
        assert_eq!(problems(&h), [ChartProblem::UnknownSeat]);
        let mut p = chart(
            ChartKind::Pipeline,
            vec![seat("a", false)],
            vec![edge("x", "a")],
        );
        assert_eq!(problems(&p), [ChartProblem::UnknownSeat]);
        p.edges = vec![edge("a", "a")];
        assert!(problems(&p).contains(&ChartProblem::SelfEdge));
    }

    #[test]
    fn names_seats_and_agents_are_checked() {
        let mut c = hierarchy();
        c.name = "  ".into();
        c.seats[1].id = "a".into();
        c.seats[2].id = "a".into();
        c.edges.clear();
        c.seats[1].agent = String::new();
        assert_eq!(
            problems(&c),
            [
                ChartProblem::NoName,
                ChartProblem::SeatIdTaken,
                ChartProblem::NoAgent
            ]
        );
        let empty = chart(ChartKind::Hierarchy, vec![], vec![]);
        assert_eq!(problems(&empty), [ChartProblem::NoSeats]);
    }

    #[test]
    fn charts_are_saved_listed_duplicated_and_deleted() {
        let s = Store::open_in_memory().unwrap();
        let saved = s.chart_save(hierarchy(), 10).unwrap();
        assert!(saved.id.starts_with("chart_"));
        assert_eq!((saved.created_ms, saved.updated_ms), (10, 10));
        let mut edited = saved.clone();
        edited.name = " Renamed ".into();
        let again = s.chart_save(edited, 20).unwrap();
        assert_eq!(
            (again.name.as_str(), again.created_ms, again.updated_ms),
            ("Renamed", 10, 20)
        );
        assert_eq!(s.chart_list().unwrap(), std::slice::from_ref(&again));
        let copy = s.chart_duplicate(&again.id, "Renamed copy", 30).unwrap();
        assert_ne!(copy.id, again.id);
        assert_eq!(copy.seats, again.seats);
        assert_eq!(s.chart_list().unwrap().len(), 2);
        assert!(s.chart_delete(&again.id).unwrap());
        assert!(!s.chart_delete(&again.id).unwrap());
        assert_eq!(s.chart_list().unwrap(), [copy]);
        let mut bad = hierarchy();
        bad.seats[0].lead = false;
        assert_eq!(s.chart_save(bad, 40).unwrap_err().code, "invalid_chart");
        assert_eq!(
            s.chart_duplicate("chart_nope", "x", 1).unwrap_err().code,
            "not_found"
        );
    }

    fn bound(s: &Store) -> ChartRun {
        let c = s.chart_save(hierarchy(), 1).unwrap();
        let tabs = [("lead", "t-lead"), ("a", "t-a"), ("b", "t-b")].map(|(seat, tab)| SeatTab {
            seat: seat.into(),
            tab: tab.into(),
        });
        s.chart_run_bind(&c.id, &tabs, 2).unwrap()
    }

    #[test]
    fn a_run_records_its_members_and_links_along_the_edges() {
        let s = Store::open_in_memory().unwrap();
        let run = bound(&s);
        assert_eq!(run.members.len(), 3);
        let a = s.chart_member("t-a").unwrap().unwrap();
        assert_eq!(a.lead_tab.as_deref(), Some("t-lead"));
        assert!(a.is_hierarchy_worker());
        assert!(
            !s.chart_member("t-lead")
                .unwrap()
                .unwrap()
                .is_hierarchy_worker()
        );
        let l = s.link_get("t-lead", "t-a").unwrap().unwrap();
        assert!(l.transcript && !l.screen);
        assert_eq!(s.link_list().unwrap().len(), 2);
        assert_eq!(s.chart_members_prune(&|t| t != "t-b").unwrap(), 1);
        assert!(s.chart_member("t-b").unwrap().is_none());
    }

    #[test]
    fn a_run_needs_one_tab_per_seat() {
        let s = Store::open_in_memory().unwrap();
        let c = s.chart_save(hierarchy(), 1).unwrap();
        let one = [SeatTab {
            seat: "lead".into(),
            tab: "t".into(),
        }];
        assert_eq!(
            s.chart_run_bind(&c.id, &one, 2).unwrap_err().code,
            "bad_request"
        );
        let twice = [("lead", "t"), ("a", "t"), ("b", "u")].map(|(seat, tab)| SeatTab {
            seat: seat.into(),
            tab: tab.into(),
        });
        assert_eq!(
            s.chart_run_bind(&c.id, &twice, 2).unwrap_err().code,
            "bad_request"
        );
        assert!(s.chart_members().unwrap().is_empty());
    }

    fn member(tab: &str, run: &str, lead_tab: Option<&str>, kind: ChartKind) -> ChartMember {
        ChartMember {
            tab: tab.into(),
            run_id: run.into(),
            chart_id: "chart_x".into(),
            seat: tab.into(),
            kind,
            lead_tab: lead_tab.map(str::to_owned),
        }
    }

    #[test]
    fn a_hierarchy_worker_hands_off_to_its_lead_only() {
        let worker = member("a", "r", Some("lead"), ChartKind::Hierarchy);
        let lead = member("lead", "r", None, ChartKind::Hierarchy);
        assert!(may_hand_off(Some(&worker), "lead"));
        assert!(!may_hand_off(Some(&worker), "b"));
        assert!(!may_hand_off(Some(&worker), "elsewhere"));
        // The lead, tabs outside a chart and other kinds are free.
        assert!(may_hand_off(Some(&lead), "a"));
        assert!(may_hand_off(None, "a"));
        let stage = member("s1", "r", None, ChartKind::Pipeline);
        assert!(may_hand_off(Some(&stage), "s2"));
    }

    #[test]
    fn a_hierarchy_worker_mails_no_teammate_but_its_lead() {
        let worker = member("a", "r", Some("lead"), ChartKind::Hierarchy);
        let sibling = member("b", "r", Some("lead"), ChartKind::Hierarchy);
        let lead = member("lead", "r", None, ChartKind::Hierarchy);
        let other_run = member("z", "r2", Some("lead2"), ChartKind::Hierarchy);
        assert!(may_mail(Some(&worker), Some(&lead)));
        assert!(!may_mail(Some(&worker), Some(&sibling)));
        assert!(may_mail(Some(&worker), Some(&other_run)));
        assert!(may_mail(Some(&worker), None));
        assert!(may_mail(Some(&lead), Some(&worker)));
        assert!(may_mail(None, Some(&sibling)));
    }

    #[test]
    fn the_store_refuses_a_handoff_the_rule_forbids() {
        let s = Store::open_in_memory().unwrap();
        bound(&s);
        assert_eq!(
            s.handoff("t-a", "t-b", "psst", 3).unwrap_err().code,
            "denied"
        );
        assert!(s.handoff("t-a", "t-lead", "done", 3).is_ok());
        assert!(s.handoff("t-lead", "t-b", "go", 3).is_ok());
        assert!(s.check_hand_off("t-b", "t-a").is_err());
    }
}
