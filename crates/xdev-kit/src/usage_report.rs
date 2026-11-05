//! A filtered view of the usage index for the Stats page: an agent filter, a
//! folder scope, an optional start day (All time), per-agent totals, the
//! session count and the earliest session start.

use serde::{Deserialize, Serialize};

use crate::pricing::{PRICES_AS_OF, cost_nanos, rates_for};
use crate::usage::SYNTHETIC;
use crate::{Agent, SessionUsage, Tokens, UsageIndex, UsageQuery, UsageSummary, summarize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct ReportQuery {
    /// Inclusive `YYYY-MM-DD`; `None` is All time.
    pub since_day: Option<String>,
    /// Inclusive `YYYY-MM-DD`.
    pub until_day: String,
    /// The agents to count; empty counts none.
    pub agents: Vec<Agent>,
    /// `None` counts every folder; `Some` only sessions whose folder is under
    /// one of these.
    pub folders: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct UsageReport {
    /// Same shape as `summarize`, filtered.
    pub summary: UsageSummary,
    /// Largest first.
    pub by_agent: Vec<(Agent, Tokens)>,
    /// Sessions with tokens in the range.
    pub sessions: u32,
    /// Unix ms of the earliest session start (> 0) among the counted agents,
    /// whatever the range.
    pub tracking_since: Option<i64>,
    /// Est. API-equivalent cost of the counted tokens.
    pub cost: Cost,
    /// Same order as `by_agent`.
    pub cost_by_agent: Vec<(Agent, Cost)>,
    /// At most 10, newest `last` first; `total` and `days` cover the range only.
    pub recent_sessions: Vec<SessionUsage>,
    /// Day the local price table was last checked, `YYYY-MM-DD`.
    pub prices_as_of: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Cost {
    /// Sum over priced session-days, nano-USD.
    pub nanos: u64,
    /// Some tokens in range belong to a model with no rate.
    pub unpriced: bool,
    /// At least one priced token; false means the UI shows "n/a".
    pub priced: bool,
}

/// Totals for the days `since_day..=until_day` (every day when `since_day` is
/// `None`) of the sessions that pass the agent and folder filters.
pub fn report(index: &UsageIndex, q: &ReportQuery) -> UsageReport {
    let kept: Vec<(&String, &SessionUsage)> = index
        .sessions
        .iter()
        .filter(|(_, s)| q.agents.contains(&s.agent))
        .filter(|(_, s)| match (&q.folders, &s.folder) {
            (None, _) => true,
            (Some(roots), Some(folder)) => under_any(folder, roots),
            (Some(_), None) => false,
        })
        .collect();

    let tracking_since = kept.iter().map(|(_, s)| s.first).filter(|f| *f > 0).min();

    let since = q.since_day.as_deref().unwrap_or("");
    let mut sessions = 0;
    let mut per_agent: Vec<(Agent, Tokens)> = Vec::new();
    for agent in [Agent::Claude, Agent::Codex] {
        if q.agents.contains(&agent) {
            per_agent.push((agent, Tokens::default()));
        }
    }
    let mut costs: Vec<(Agent, Cost)> = per_agent
        .iter()
        .map(|(a, _)| (*a, Cost::default()))
        .collect();
    let mut ranged: Vec<SessionUsage> = Vec::new();
    for (_, s) in &kept {
        let mut in_range = Tokens::default();
        let mut days = std::collections::BTreeMap::new();
        for (day, t) in &s.days {
            if day.as_str() >= since && day.as_str() <= q.until_day.as_str() {
                in_range.add(t);
                days.insert(day.clone(), *t);
            }
        }
        if in_range.sum() == 0 {
            continue;
        }
        sessions += 1;
        if let Some((_, total)) = per_agent.iter_mut().find(|(a, _)| *a == s.agent) {
            total.add(&in_range);
        }
        if let Some((_, cost)) = costs.iter_mut().find(|(a, _)| *a == s.agent) {
            // Each model's tokens at that model's rate.
            for (model, day, t) in s.model_days() {
                if model == SYNTHETIC || day < since || day > q.until_day.as_str() || t.sum() == 0 {
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
        }
        let mut ranged_session = (*s).clone();
        ranged_session.total = in_range;
        ranged_session.days = days;
        ranged_session.models = s.models_in(since, &q.until_day);
        ranged.push(ranged_session);
    }
    // Stable: equal totals stay Claude before Codex.
    per_agent.sort_by_key(|(_, t)| std::cmp::Reverse(t.sum()));
    let cost_by_agent: Vec<(Agent, Cost)> = per_agent
        .iter()
        .filter_map(|(a, _)| costs.iter().find(|(c, _)| c == a).copied())
        .collect();
    let cost = cost_by_agent
        .iter()
        .fold(Cost::default(), |acc, (_, c)| Cost {
            nanos: acc.nanos.saturating_add(c.nanos),
            unpriced: acc.unpriced || c.unpriced,
            priced: acc.priced || c.priced,
        });
    ranged.sort_by(|a, b| b.last.cmp(&a.last).then_with(|| a.id.cmp(&b.id)));
    ranged.truncate(10);

    let filtered = UsageIndex {
        sessions: kept
            .iter()
            .map(|(k, s)| ((*k).clone(), (*s).clone()))
            .collect(),
        ..UsageIndex::default()
    };
    let summary = summarize(
        &filtered,
        &UsageQuery {
            since_day: since.to_owned(),
            until_day: q.until_day.clone(),
        },
    );
    UsageReport {
        summary,
        by_agent: per_agent,
        sessions,
        tracking_since,
        cost,
        cost_by_agent,
        recent_sessions: ranged,
        prices_as_of: PRICES_AS_OF.to_owned(),
    }
}

/// Folder paths as comparable keys: on Windows the separators are one kind,
/// the case is folded as the file system does, and a canonical spelling
/// (`\\?\E:\x`, `\\?\UNC\host\share`) reads as its plain one.
fn key(path: &str) -> String {
    let mut k = if cfg!(windows) {
        windows_key(path)
    } else {
        path.to_owned()
    };
    while k.len() > 1 && k.ends_with('/') {
        k.pop();
    }
    k
}

/// The Windows form of a key, a pure string function so it is testable on
/// every OS.
fn windows_key(path: &str) -> String {
    let text = path.replace('\\', "/").to_lowercase();
    if let Some(rest) = text.strip_prefix("//?/unc/") {
        format!("//{rest}")
    } else {
        text.strip_prefix("//?/")
            .map_or(text.clone(), str::to_owned)
    }
}

/// Whether `folder` is one of `roots` or inside one, by path component, not
/// by string prefix: `/r/xdev2` is not under `/r/xdev`.
pub fn under_any(folder: &str, roots: &[String]) -> bool {
    let folder = key(folder);
    roots.iter().any(|root| {
        let root = key(root);
        if root.is_empty() {
            return false;
        }
        folder == root
            || folder
                .strip_prefix(&root)
                .is_some_and(|rest| root.ends_with('/') || rest.starts_with('/'))
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::Path;

    use super::*;
    use crate::{Home, HomeSource, UsageQuery, summarize};

    #[test]
    fn windows_key_reads_a_canonical_path_as_its_plain_spelling() {
        assert_eq!(windows_key(r"\\?\E:\Codes\xDev"), "e:/codes/xdev");
        assert_eq!(windows_key(r"\\?\UNC\Host\Share\x"), "//host/share/x");
        assert_eq!(windows_key(r"E:\Codes\xDev"), "e:/codes/xdev");
    }

    fn tok(n: u64) -> Tokens {
        Tokens {
            input: n,
            output: 0,
            cache_read: 0,
            cache_write: 0,
        }
    }

    fn session(
        id: &str,
        agent: Agent,
        folder: Option<&str>,
        first: i64,
        days: &[(&str, u64)],
    ) -> SessionUsage {
        let days: BTreeMap<String, Tokens> = days
            .iter()
            .map(|(d, n)| ((*d).to_owned(), tok(*n)))
            .collect();
        let mut total = Tokens::default();
        for t in days.values() {
            total.add(t);
        }
        SessionUsage {
            id: id.to_owned(),
            home_id: "h".to_owned(),
            agent,
            folder: folder.map(str::to_owned),
            model: Some("m".to_owned()),
            first,
            last: first,
            total,
            days,
            models: BTreeMap::new(),
        }
    }

    fn index() -> UsageIndex {
        let mut i = UsageIndex::default();
        for s in [
            session(
                "a",
                Agent::Claude,
                Some("/r/xdev/wt/a"),
                1_000,
                &[("2026-10-01", 5), ("2026-11-02", 10)],
            ),
            session(
                "b",
                Agent::Codex,
                Some("/r/xdev"),
                500,
                &[("2026-11-02", 30)],
            ),
            session(
                "c",
                Agent::Claude,
                Some("/other"),
                2_000,
                &[("2026-11-03", 7)],
            ),
            session("d", Agent::Codex, None, 0, &[("2026-11-03", 1)]),
        ] {
            i.sessions.insert(format!("h:{}", s.id), s);
        }
        i
    }

    fn q(agents: &[Agent]) -> ReportQuery {
        ReportQuery {
            since_day: Some("2026-11-01".to_owned()),
            until_day: "2026-11-30".to_owned(),
            agents: agents.to_vec(),
            folders: None,
        }
    }

    fn both() -> [Agent; 2] {
        [Agent::Claude, Agent::Codex]
    }

    #[test]
    fn the_agent_filter_counts_only_those_agents() {
        let r = report(&index(), &q(&[Agent::Claude]));
        assert_eq!(r.sessions, 2);
        assert_eq!(r.by_agent, vec![(Agent::Claude, tok(17))]);
        let r = report(&index(), &q(&both()));
        assert_eq!(r.sessions, 4);
    }

    #[test]
    fn the_folder_scope_matches_whole_components() {
        let mut query = q(&both());
        query.folders = Some(vec!["/r/xdev".to_owned()]);
        let r = report(&index(), &query);
        // a and b; c is elsewhere, d has no folder.
        assert_eq!(r.sessions, 2);
        assert!(under_any("/r/xdev", &["/r/xdev".to_owned()]));
        assert!(under_any("/r/xdev/wt/a", &["/r/xdev".to_owned()]));
        assert!(under_any("/r/xdev/wt/a", &["/r/xdev/".to_owned()]));
        assert!(!under_any("/r/xdev2", &["/r/xdev".to_owned()]));
        assert!(!under_any("/r", &["/r/xdev".to_owned()]));
        assert!(!under_any("/r/xdev", &[]));
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths_ignore_case_and_separator() {
        assert!(under_any(r"C:\R\Xdev", &["c:/r/xdev".to_owned()]));
        assert!(under_any(r"C:\R\Xdev\wt", &["c:/r/xdev".to_owned()]));
        assert!(!under_any(r"C:\R\Xdev2", &["c:/r/xdev".to_owned()]));
    }

    #[cfg(not(windows))]
    #[test]
    fn unix_paths_are_case_sensitive() {
        assert!(!under_any("/R/Xdev", &["/r/xdev".to_owned()]));
    }

    #[test]
    fn no_start_day_counts_every_day() {
        let mut query = q(&[Agent::Claude]);
        let r = report(&index(), &query);
        assert_eq!(r.by_agent[0].1, tok(17));
        query.since_day = None;
        let r = report(&index(), &query);
        assert_eq!(r.by_agent[0].1, tok(22));
        assert_eq!(r.summary.days.len(), 3);
    }

    #[test]
    fn tracking_since_ignores_unset_starts_and_the_range() {
        let r = report(&index(), &q(&both()));
        assert_eq!(r.tracking_since, Some(500));
        let mut query = q(&[Agent::Codex]);
        query.since_day = Some("2026-11-03".to_owned());
        // b is outside the range but still the earliest; d has first == 0.
        assert_eq!(report(&index(), &query).tracking_since, Some(500));
        let mut only_d = index();
        only_d.sessions.retain(|_, s| s.id == "d");
        assert_eq!(report(&only_d, &q(&both())).tracking_since, None);
    }

    #[test]
    fn no_agents_is_an_empty_report() {
        let r = report(&index(), &q(&[]));
        assert_eq!(r.sessions, 0);
        assert!(r.by_agent.is_empty());
        assert!(r.summary.days.is_empty());
        assert_eq!(r.tracking_since, None);
    }

    #[test]
    fn by_agent_is_largest_first() {
        let r = report(&index(), &q(&both()));
        assert_eq!(
            r.by_agent,
            vec![(Agent::Codex, tok(31)), (Agent::Claude, tok(17))]
        );
    }

    fn modelled(
        id: &str,
        agent: Agent,
        model: Option<&str>,
        last: i64,
        day: &str,
        n: u64,
    ) -> SessionUsage {
        let mut s = session(id, agent, None, 1, &[(day, n)]);
        s.model = model.map(str::to_owned);
        s.last = last;
        s
    }

    fn priced_index() -> UsageIndex {
        let mut i = UsageIndex::default();
        for s in [
            modelled(
                "p",
                Agent::Claude,
                Some("claude-sonnet-4-5"),
                30,
                "2026-11-02",
                1_000_000,
            ),
            modelled(
                "q",
                Agent::Claude,
                Some("claude-opus-9"),
                20,
                "2026-11-02",
                50,
            ),
            modelled(
                "r",
                Agent::Codex,
                Some("gpt-5"),
                10,
                "2026-11-02",
                1_000_000,
            ),
            modelled(
                "old",
                Agent::Codex,
                Some("gpt-5"),
                99,
                "2026-09-01",
                1_000_000,
            ),
        ] {
            i.sessions.insert(format!("h:{}", s.id), s);
        }
        i
    }

    #[test]
    fn a_session_is_priced_per_model_not_by_its_last() {
        let mut s = modelled(
            "mix",
            Agent::Claude,
            Some("claude-opus-9"),
            1,
            "2026-11-02",
            1_000_050,
        );
        let day = |d: &str, n: u64| BTreeMap::from([(d.to_owned(), tok(n))]);
        let mut sonnet = day("2026-11-02", 1_000_000);
        // Out of range: not priced.
        sonnet.insert("2026-10-01".to_owned(), tok(1_000_000));
        s.models = BTreeMap::from([
            ("claude-sonnet-4-5".to_owned(), sonnet),
            ("claude-opus-9".to_owned(), day("2026-11-02", 50)),
        ]);
        let mut idx = UsageIndex::default();
        idx.sessions.insert("h:mix".to_owned(), s);
        let r = report(&idx, &q(&both()));
        assert_eq!(
            r.cost,
            Cost {
                nanos: 3_000_000_000,
                unpriced: true,
                priced: true,
            }
        );
    }

    #[test]
    fn a_synthetic_model_is_neither_priced_nor_unpriced() {
        let mut s = modelled(
            "syn",
            Agent::Claude,
            Some("claude-sonnet-4-5"),
            1,
            "2026-11-02",
            1_000_000,
        );
        let day = |n: u64| BTreeMap::from([("2026-11-02".to_owned(), tok(n))]);
        s.models = BTreeMap::from([
            ("claude-sonnet-4-5".to_owned(), day(1_000_000)),
            ("<synthetic>".to_owned(), day(7)),
        ]);
        let mut idx = UsageIndex::default();
        idx.sessions.insert("h:syn".to_owned(), s);
        let r = report(&idx, &q(&both()));
        assert_eq!(
            r.cost,
            Cost {
                nanos: 3_000_000_000,
                unpriced: false,
                priced: true,
            }
        );
    }

    #[test]
    fn cost_sums_priced_tokens_and_flags_the_unpriced() {
        let r = report(&priced_index(), &q(&both()));
        // Input only: sonnet 3000 nano/token, gpt-5 1250 nano/token.
        let claude = Cost {
            nanos: 3_000_000_000,
            unpriced: true,
            priced: true,
        };
        let codex = Cost {
            nanos: 1_250_000_000,
            unpriced: false,
            priced: true,
        };
        assert_eq!(r.cost_by_agent.len(), 2);
        for (a, c) in &r.cost_by_agent {
            assert_eq!(*c, if *a == Agent::Claude { claude } else { codex });
        }
        assert_eq!(
            r.cost,
            Cost {
                nanos: 4_250_000_000,
                unpriced: true,
                priced: true
            }
        );
    }

    #[test]
    fn only_unpriced_tokens_are_not_priced() {
        let mut query = q(&[Agent::Claude]);
        query.folders = None;
        let mut idx = priced_index();
        idx.sessions.remove("h:p");
        let r = report(&idx, &query);
        assert_eq!(
            r.cost,
            Cost {
                nanos: 0,
                unpriced: true,
                priced: false
            }
        );
        assert_eq!(report(&idx, &q(&[])).cost, Cost::default());
    }

    #[test]
    fn recent_sessions_are_newest_first_and_cover_the_range_only() {
        let r = report(&priced_index(), &q(&both()));
        let ids: Vec<&str> = r.recent_sessions.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["p", "q", "r"]);
        assert_eq!(r.recent_sessions[0].total.sum(), 1_000_000);
        // The old session is out of range, so it is not listed.
        assert!(!ids.contains(&"old"));
        let mut query = q(&both());
        query.since_day = None;
        let r = report(&priced_index(), &query);
        assert_eq!(r.recent_sessions[0].id, "old");
    }

    #[test]
    fn at_most_ten_recent_sessions() {
        let mut idx = UsageIndex::default();
        for n in 0..14 {
            let s = modelled(
                &format!("s{n:02}"),
                Agent::Claude,
                Some("claude-sonnet-4-5"),
                n,
                "2026-11-02",
                5,
            );
            idx.sessions.insert(format!("h:{}", s.id), s);
        }
        let r = report(&idx, &q(&both()));
        assert_eq!(r.recent_sessions.len(), 10);
        assert_eq!(r.recent_sessions[0].id, "s13");
        assert_eq!(r.sessions, 14);
    }

    #[test]
    fn the_report_names_the_price_table_date() {
        let r = report(&UsageIndex::default(), &q(&both()));
        assert_eq!(r.prices_as_of, crate::pricing::PRICES_AS_OF);
    }

    fn fixture(name: &str) -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join(name)
    }

    fn copy_tree(from: &Path, to: &Path) {
        fs::create_dir_all(to).unwrap();
        for entry in fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            let target = to.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy_tree(&entry.path(), &target);
            } else {
                fs::copy(entry.path(), target).unwrap();
            }
        }
    }

    #[test]
    fn the_fixture_totals_equal_summarize() {
        let dir = tempfile::tempdir().unwrap();
        let mut homes = Vec::new();
        for (id, agent, sub) in [
            ("own-claude", Agent::Claude, "claude"),
            ("own-codex", Agent::Codex, "codex"),
        ] {
            let path = dir.path().join(sub);
            copy_tree(&fixture(sub), &path);
            homes.push(Home {
                id: id.to_owned(),
                agent,
                path,
                source: HomeSource::Own,
            });
        }
        let mut idx = UsageIndex::default();
        idx.refresh(&homes, 0);
        let (since, until) = ("2026-11-01", "2026-11-30");
        let want = summarize(
            &idx,
            &UsageQuery {
                since_day: since.to_owned(),
                until_day: until.to_owned(),
            },
        );
        let got = report(
            &idx,
            &ReportQuery {
                since_day: Some(since.to_owned()),
                until_day: until.to_owned(),
                agents: both().to_vec(),
                folders: None,
            },
        );
        assert_eq!(got.summary, want);
        assert!(got.sessions > 0);
        let sum: u64 = got.by_agent.iter().map(|(_, t)| t.sum()).sum();
        let days: u64 = want.days.iter().map(|(_, t)| t.sum()).sum();
        assert_eq!(sum, days);
    }
}
