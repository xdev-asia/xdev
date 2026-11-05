//! What running terminals cost: CPU and memory per tab (its pty child and everything below it) and
//! for the app itself.

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use tauri::State;

use crate::pty::Ptys;

/// One process, as the OS table reports it.
#[derive(Debug, Clone, PartialEq)]
pub struct ProcRow {
    pub pid: u32,
    pub parent: Option<u32>,
    /// CPU use in percent of one core.
    pub cpu: f32,
    pub memory: u64,
}

/// One tab's (or the app's) total over a process tree.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ResourceRow {
    /// The tab id; absent for the app itself.
    #[cfg_attr(test, ts(optional))]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    pub pid: u32,
    pub cpu: f32,
    pub memory_bytes: u64,
    pub processes: u32,
}

/// The rows the resource view shows.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ResourceSnapshot {
    pub app: ResourceRow,
    /// Sorted by memory, largest first.
    pub tabs: Vec<ResourceRow>,
}

/// Sums `root` and all its descendants into one row. A root missing from the table gives `None`.
/// A cycle in parent links is walked once.
pub fn aggregate(table: &[ProcRow], root: u32, tab_id: Option<String>) -> Option<ResourceRow> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut by_pid: HashMap<u32, &ProcRow> = HashMap::new();
    for p in table {
        by_pid.insert(p.pid, p);
        if let Some(parent) = p.parent {
            children.entry(parent).or_default().push(p.pid);
        }
    }
    if !by_pid.contains_key(&root) {
        return None;
    }
    let mut seen: HashSet<u32> = HashSet::new();
    let mut stack = vec![root];
    let (mut cpu, mut memory, mut processes) = (0.0_f32, 0_u64, 0_u32);
    while let Some(pid) = stack.pop() {
        if !seen.insert(pid) {
            continue;
        }
        if let Some(p) = by_pid.get(&pid) {
            cpu += p.cpu;
            memory = memory.saturating_add(p.memory);
            processes += 1;
        }
        if let Some(kids) = children.get(&pid) {
            stack.extend(kids.iter().copied());
        }
    }
    Some(ResourceRow {
        tab_id,
        pid: root,
        cpu,
        memory_bytes: memory,
        processes,
    })
}

/// One row per tab pid that is in the table, biggest memory first, plus the app's own process.
pub fn snapshot(
    table: &[ProcRow],
    tabs: &[(String, u32)],
    app_pid: u32,
) -> Option<ResourceSnapshot> {
    // The app's row is its own process only: its child terminals are listed under their tabs.
    let own = table.iter().find(|p| p.pid == app_pid)?;
    let app = ResourceRow {
        tab_id: None,
        pid: app_pid,
        cpu: own.cpu,
        memory_bytes: own.memory,
        processes: 1,
    };
    let mut rows: Vec<ResourceRow> = tabs
        .iter()
        .filter_map(|(id, pid)| aggregate(table, *pid, Some(id.clone())))
        .collect();
    rows.sort_by(|a, b| {
        b.memory_bytes
            .cmp(&a.memory_bytes)
            .then_with(|| a.tab_id.cmp(&b.tab_id))
    });
    Some(ResourceSnapshot { app, tabs: rows })
}

/// Two reads of the process table a moment apart: CPU % needs the second.
fn read_table() -> Vec<ProcRow> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
    let Ok(mut system) = System::new() else {
        return Vec::new();
    };
    let kind = ProcessRefreshKind::nothing().with_cpu().with_memory();
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
    std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
    system
        .processes()
        .iter()
        .map(|(pid, p)| ProcRow {
            pid: pid.as_u32(),
            parent: p.parent().map(sysinfo::Pid::as_u32),
            cpu: p.cpu_usage(),
            memory: p.memory(),
        })
        .collect()
}

/// CPU and memory of every running tab and of the app.
#[tauri::command(async)]
pub fn resources_snapshot(ptys: State<'_, Ptys>) -> Option<ResourceSnapshot> {
    snapshot(&read_table(), &ptys.pids(), std::process::id())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(pid: u32, parent: Option<u32>, cpu: f32, memory: u64) -> ProcRow {
        ProcRow {
            pid,
            parent,
            cpu,
            memory,
        }
    }

    fn table() -> Vec<ProcRow> {
        vec![
            p(1, None, 0.0, 10),
            p(10, Some(1), 1.0, 100),
            p(11, Some(10), 2.5, 50),
            p(12, Some(11), 0.5, 25),
            p(20, Some(1), 4.0, 400),
            p(30, Some(99), 9.0, 999),
        ]
    }

    #[test]
    fn a_tree_sums_the_root_and_every_descendant() {
        let r = aggregate(&table(), 10, Some("a".into())).unwrap();
        assert_eq!((r.memory_bytes, r.processes), (175, 3));
        assert!((r.cpu - 4.0).abs() < 1e-6);
        assert_eq!(r.tab_id.as_deref(), Some("a"));
    }

    #[test]
    fn a_missing_root_gives_nothing_and_a_leaf_is_one_process() {
        assert_eq!(aggregate(&table(), 777, None), None);
        assert_eq!(aggregate(&table(), 12, None).unwrap().processes, 1);
    }

    #[test]
    fn a_parent_cycle_is_walked_once() {
        let t = vec![p(1, Some(2), 1.0, 5), p(2, Some(1), 1.0, 5)];
        let r = aggregate(&t, 1, None).unwrap();
        assert_eq!((r.processes, r.memory_bytes), (2, 10));
    }

    #[test]
    fn the_snapshot_sorts_by_memory_and_skips_gone_tabs() {
        let tabs = vec![
            ("small".to_string(), 12),
            ("big".to_string(), 20),
            ("gone".to_string(), 555),
            ("mid".to_string(), 10),
        ];
        let s = snapshot(&table(), &tabs, 1).unwrap();
        let ids: Vec<_> = s.tabs.iter().map(|r| r.tab_id.clone().unwrap()).collect();
        assert_eq!(ids, ["big", "mid", "small"]);
        assert_eq!((s.app.pid, s.app.memory_bytes, s.app.tab_id), (1, 10, None));
    }

    #[test]
    fn no_app_row_in_the_table_gives_no_snapshot() {
        assert_eq!(snapshot(&table(), &[], 4242), None);
    }
}
