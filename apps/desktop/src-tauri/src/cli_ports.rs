//! `ports.list`: the listening ports of one worktree, or of all, with the
//! process and the worktree each belongs to. The scan is `xdev-ports`'s.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{Value, json};
use xdev_ports::{PortKind, WorkspacePort};
use xdev_workspace::path_key;

use crate::cli_verbs::{Ctx, params, target};
use crate::endpoint::{AppError, Caller, Request};

#[derive(Deserialize)]
struct ListParams {
    worktree: Option<String>,
    #[serde(default)]
    all: bool,
}

/// The ports of a worktree, in port then pid order: those of `keys` (the
/// `path_key` of each wanted worktree), or of every worktree when none.
pub fn select<'a>(
    ports: &'a [WorkspacePort],
    keys: Option<&HashSet<String>>,
) -> Vec<&'a WorkspacePort> {
    let mut out: Vec<&WorkspacePort> = ports
        .iter()
        .filter(|p| p.kind == PortKind::Workspace)
        .filter(|p| match (keys, &p.worktree) {
            (None, _) => true,
            (Some(keys), Some(w)) => keys.contains(&path_key(Path::new(w))),
            (Some(_), None) => false,
        })
        .collect();
    out.sort_by_key(|p| (p.port, p.pid));
    out
}

/// One port as `--json` gives it; `names` maps a worktree's `path_key` to its name.
pub fn row(p: &WorkspacePort, names: &HashMap<String, String>) -> Value {
    let name = p
        .worktree
        .as_deref()
        .map(|w| names.get(&path_key(Path::new(w))).map_or(w, String::as_str));
    json!({
        "port": p.port,
        "pid": p.pid,
        "process": p.process_name,
        "worktree": p.worktree,
        "worktreeName": name,
        "url": p.url,
        "protocol": p.protocol,
    })
}

/// `ports.list`: the caller's worktree, the named one, or with `all` every
/// worktree. From outside xDev's terminals, with none named, it is all.
pub fn ports_list(ctx: &Ctx<'_>, req: &Request, caller: &Caller) -> Result<Value, AppError> {
    let p: ListParams = params(req)?;
    let listed = ctx.listed()?;
    let me = ctx.caller_worktree(caller)?;
    let names: HashMap<String, String> = listed
        .iter()
        .map(|l| (path_key(Path::new(&l.view.path)), l.view.name.clone()))
        .collect();
    let keys: Option<HashSet<String>> = if p.all || (p.worktree.is_none() && me.is_none()) {
        None
    } else {
        let l = target(&listed, p.worktree.as_deref(), me.as_deref())?;
        Some(HashSet::from([path_key(Path::new(&l.view.path))]))
    };
    let worktrees: Vec<PathBuf> = listed.iter().map(|l| PathBuf::from(&l.view.path)).collect();
    let scan = (ctx.scan_ports)(&worktrees);
    let ports: Vec<Value> = select(&scan.ports, keys.as_ref())
        .into_iter()
        .map(|port| row(port, &names))
        .collect();
    Ok(json!({ "ports": ports, "unavailable": scan.unavailable }))
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use xdev_ports::{PortProtocol, PortScan};

    use super::*;
    use crate::cli_verbs::tests::fixture;

    fn port(port: u16, pid: u32, kind: PortKind, worktree: Option<&Path>) -> WorkspacePort {
        WorkspacePort {
            id: format!("localhost:{port}:{pid}"),
            bind_host: "127.0.0.1".into(),
            connect_host: "localhost".into(),
            port,
            pid: Some(pid),
            process_name: Some("node".into()),
            protocol: PortProtocol::Http,
            kind,
            worktree: worktree.map(|w| w.display().to_string()),
            evidence: None,
            url: format!("http://localhost:{port}"),
            advertised: false,
        }
    }

    fn keys(paths: &[&Path]) -> HashSet<String> {
        paths.iter().map(|p| path_key(p)).collect()
    }

    #[test]
    fn select_keeps_the_wanted_worktrees_in_port_order() {
        let (a, b) = (Path::new("/r/a"), Path::new("/r/b"));
        let ports = vec![
            port(8080, 3, PortKind::Workspace, Some(a)),
            port(3000, 2, PortKind::Workspace, Some(b)),
            port(5173, 1, PortKind::Workspace, Some(a)),
            port(22, 9, PortKind::External, None),
            port(5432, 8, PortKind::Container, None),
        ];
        let only_a = select(&ports, Some(&keys(&[a])));
        assert_eq!(
            only_a.iter().map(|p| p.port).collect::<Vec<_>>(),
            [5173, 8080]
        );
        // Every worktree, but never a port that belongs to none.
        let all = select(&ports, None);
        assert_eq!(
            all.iter().map(|p| p.port).collect::<Vec<_>>(),
            [3000, 5173, 8080]
        );
        assert!(select(&ports, Some(&keys(&[Path::new("/r/c")]))).is_empty());
    }

    #[test]
    fn a_row_has_stable_field_names() {
        let a = Path::new("/r/a");
        let names = HashMap::from([(path_key(a), "alpha".to_owned())]);
        let r = row(&port(5173, 42, PortKind::Workspace, Some(a)), &names);
        assert_eq!(
            r,
            json!({
                "port": 5173, "pid": 42, "process": "node",
                "worktree": "/r/a", "worktreeName": "alpha",
                "url": "http://localhost:5173", "protocol": "http",
            })
        );
    }

    #[test]
    fn the_verb_defaults_to_the_callers_worktree_and_all_widens_it() {
        let mut f = fixture();
        f.scan = PortScan {
            ports: vec![
                port(5173, 1, PortKind::Workspace, Some(&f.lead)),
                port(3000, 2, PortKind::Workspace, Some(&f.other)),
                port(22, 3, PortKind::External, None),
            ],
            unavailable: None,
            ..PortScan::no_terminal()
        };
        let ports = |r: &Value| -> Vec<u64> {
            r["ports"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| p["port"].as_u64().unwrap())
                .collect()
        };
        // From a terminal of `lead` (its PTY starts in a folder under it).
        let r = f.call(Some("p-lead"), "ports.list", json!({})).unwrap();
        assert_eq!(ports(&r), [5173]);
        assert_eq!(r["ports"][0]["worktreeName"], "lead");
        let r = f
            .call(Some("p-lead"), "ports.list", json!({ "all": true }))
            .unwrap();
        assert_eq!(ports(&r), [3000, 5173]);
        let r = f
            .call(Some("p-lead"), "ports.list", json!({ "worktree": "other" }))
            .unwrap();
        assert_eq!(ports(&r), [3000]);
        // From outside, with none named, every worktree.
        let r = f.call(None, "ports.list", json!({})).unwrap();
        assert_eq!(ports(&r), [3000, 5173]);
        // The scan was asked about every known worktree each time.
        let asked = f.scanned.lock().unwrap();
        assert_eq!(asked.len(), 4);
        assert!(asked.iter().all(|w| w.len() >= 3));
    }

    #[test]
    fn an_unknown_worktree_is_not_found_and_no_scan_means_no_ports() {
        let f = fixture();
        let e = f
            .call(None, "ports.list", json!({ "worktree": "nope" }))
            .unwrap_err();
        assert_eq!(e.code, "not_found");
        let r = f.call(None, "ports.list", json!({})).unwrap();
        assert_eq!(r["ports"], json!([]));
        assert_eq!(r["unavailable"], "no_terminal");
    }
}
