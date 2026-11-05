//! Ties each listening port to a worktree, or calls it a container service or
//! an outside one. Pure: listeners and processes in, ports out.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;

use crate::{Listener, PortEvidence, PortKind, PortProtocol, Proc, PtyRoot, WorkspacePort};

/// The most ports a scan reports.
pub const PORT_CAP: usize = 200;

/// How many parents the walk from a listener to a terminal's root climbs.
const WALK_DEPTH: usize = 64;

/// Looks up the origin a terminal of a worktree printed for a port.
pub type Advertised<'a> = &'a dyn Fn(&Path, u16) -> Option<String>;

/// The protocol a port number usually speaks.
pub fn guess_protocol(port: u16) -> PortProtocol {
    match port {
        443 | 8443 => PortProtocol::Https,
        80 | 3000 | 3001 | 4200 | 5000 | 5173 | 5174 | 8000 | 8080 | 8888 => PortProtocol::Http,
        _ => PortProtocol::Unknown,
    }
}

/// A path as it is compared: forward slashes, no `\\?\` prefix, no trailing
/// slash, lower case where the file system ignores case (Windows).
pub fn norm_path(path: &Path) -> String {
    norm_with(&path.to_string_lossy(), cfg!(windows))
}

fn norm_with(raw: &str, fold: bool) -> String {
    let mut s = raw.replace('\\', "/");
    if let Some(rest) = s.strip_prefix("//?/") {
        s = rest.to_owned();
    }
    while s.len() > 1 && s.ends_with('/') {
        s.pop();
    }
    if fold { s.to_lowercase() } else { s }
}

/// Whether `child` is `base` or below it, on a path boundary.
fn is_inside(child: &str, base: &str) -> bool {
    match child.strip_prefix(base) {
        Some("") => true,
        Some(rest) => base.ends_with('/') || rest.starts_with('/'),
        None => false,
    }
}

/// Whether `base` appears in `cmd` as a whole path: not glued to a longer name
/// on either side.
fn in_command(cmd: &str, base: &str) -> bool {
    let glued = |c: char| c.is_alphanumeric() || matches!(c, '.' | '_' | '-');
    let mut from = 0;
    while let Some(at) = cmd[from..].find(base) {
        let start = from + at;
        let end = start + base.len();
        let before = cmd[..start].chars().next_back();
        let after = cmd[end..].chars().next();
        if !before.is_some_and(glued) && !after.is_some_and(glued) {
            return true;
        }
        from = start + base.len().max(1);
        while !cmd.is_char_boundary(from) {
            from += 1;
        }
    }
    false
}

/// Whether a process looks like a container runtime or a service in one.
pub fn is_container(name: &str, cmd: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"(?i)\b(com\.[\w.-]+\.backend|com\.container\w*|container\w*)\b")
            .expect("container pattern")
    });
    re.is_match(name) || re.is_match(cmd)
}

struct Tree<'a> {
    by_pid: HashMap<u32, &'a Proc>,
}

impl Tree<'_> {
    /// The first root on the way up from `pid`, the pid itself included. The
    /// walk stops at a cycle or after `WALK_DEPTH` parents.
    fn root_of(&self, pid: u32, roots: &HashMap<u32, usize>) -> Option<usize> {
        let mut seen = HashSet::new();
        let mut at = pid;
        for _ in 0..=WALK_DEPTH {
            if let Some(i) = roots.get(&at) {
                return Some(*i);
            }
            if !seen.insert(at) {
                return None;
            }
            at = self.by_pid.get(&at)?.ppid?;
        }
        None
    }
}

struct Worktree<'a> {
    shown: &'a Path,
    norm: String,
}

/// The deepest worktree that contains `path`.
fn deepest<'a, 'b>(trees: &'b [Worktree<'a>], path: &str) -> Option<&'b Worktree<'a>> {
    trees
        .iter()
        .filter(|w| is_inside(path, &w.norm))
        .max_by_key(|w| w.norm.len())
}

fn connect_host(bind: &str) -> String {
    match bind {
        "*" | "0.0.0.0" | "::" | "" => "localhost".to_owned(),
        other => other.to_owned(),
    }
}

fn origin(protocol: PortProtocol, host: &str, port: u16) -> String {
    let scheme = if protocol == PortProtocol::Https {
        "https"
    } else {
        "http"
    };
    if host.contains(':') {
        format!("{scheme}://[{host}]:{port}")
    } else {
        format!("{scheme}://{host}:{port}")
    }
}

/// Whether a terminal xDev started works inside one of `worktrees`. Without
/// one there is nothing a scan could tie to a terminal, so the OS is not read.
pub fn has_terminal(roots: &[PtyRoot], worktrees: &[std::path::PathBuf]) -> bool {
    let trees: Vec<String> = worktrees.iter().map(|w| norm_path(w)).collect();
    roots.iter().any(|r| {
        let at = norm_path(&r.worktree);
        trees.iter().any(|w| is_inside(&at, w))
    })
}

/// The ports of `listeners`, each tied to a worktree by the first evidence that
/// fits: a terminal the app started there, the process's working folder, its
/// command line.
pub fn attribute(
    listeners: &[Listener],
    procs: &[Proc],
    roots: &[PtyRoot],
    worktrees: &[std::path::PathBuf],
    advertised: Advertised<'_>,
) -> Vec<WorkspacePort> {
    attribute_with(
        listeners,
        procs,
        roots,
        worktrees,
        advertised,
        cfg!(windows),
    )
}

/// `attribute` with the case folding stated, so tests cover Windows anywhere.
pub fn attribute_with(
    listeners: &[Listener],
    procs: &[Proc],
    roots: &[PtyRoot],
    worktrees: &[std::path::PathBuf],
    advertised: Advertised<'_>,
    fold: bool,
) -> Vec<WorkspacePort> {
    let trees: Vec<Worktree<'_>> = worktrees
        .iter()
        .map(|w| Worktree {
            shown: w,
            norm: norm_with(&w.to_string_lossy(), fold),
        })
        .collect();
    let tree = Tree {
        by_pid: procs.iter().map(|p| (p.pid, p)).collect(),
    };
    // A terminal counts for the worktree that contains the folder it started in.
    let mut root_pids: HashMap<u32, usize> = HashMap::new();
    let mut root_tree: Vec<usize> = Vec::new();
    for root in roots {
        let at = norm_with(&root.worktree.to_string_lossy(), fold);
        if let Some(w) = deepest(&trees, &at) {
            let index = trees.iter().position(|t| std::ptr::eq(t, w)).unwrap_or(0);
            root_pids.entry(root.pid).or_insert(root_tree.len());
            root_tree.push(index);
        }
    }

    let mut seen = HashSet::new();
    let mut ports = Vec::new();
    for listener in listeners {
        let host = connect_host(&listener.bind_host);
        let id = format!(
            "{host}:{}:{}",
            listener.port,
            listener
                .pid
                .map_or_else(|| "unknown".to_owned(), |p| p.to_string())
        );
        if !seen.insert(id.clone()) {
            continue;
        }
        let proc = listener.pid.and_then(|p| tree.by_pid.get(&p).copied());

        let mut owner: Option<(usize, PortEvidence)> = None;
        if let Some(pid) = listener.pid
            && let Some(slot) = tree.root_of(pid, &root_pids)
        {
            owner = Some((root_tree[slot], PortEvidence::Terminal));
        }
        if owner.is_none()
            && let Some(cwd) = proc.and_then(|p| p.cwd.as_deref())
            && let Some(w) = deepest(&trees, &norm_with(&cwd.to_string_lossy(), fold))
        {
            owner = trees
                .iter()
                .position(|t| std::ptr::eq(t, w))
                .map(|i| (i, PortEvidence::Cwd));
        }
        if owner.is_none()
            && let Some(p) = proc
        {
            let cmd = norm_with(&p.cmd, fold);
            owner = trees
                .iter()
                .enumerate()
                .filter(|(_, w)| in_command(&cmd, &w.norm))
                .max_by_key(|(_, w)| w.norm.len())
                .map(|(i, _)| (i, PortEvidence::Command));
        }

        let process_name = proc.map(|p| p.name.clone()).filter(|n| !n.is_empty());
        let kind = if owner.is_some() {
            PortKind::Workspace
        } else if proc.is_some_and(|p| is_container(&p.name, &p.cmd)) {
            PortKind::Container
        } else {
            PortKind::External
        };
        let guessed = guess_protocol(listener.port);
        let printed = owner.and_then(|(i, _)| advertised(trees[i].shown, listener.port));
        let (protocol, url) = match &printed {
            Some(url) => (
                if url.starts_with("https:") {
                    PortProtocol::Https
                } else {
                    PortProtocol::Http
                },
                url.clone(),
            ),
            None => (guessed, origin(guessed, &host, listener.port)),
        };
        ports.push(WorkspacePort {
            id,
            bind_host: listener.bind_host.clone(),
            connect_host: host,
            port: listener.port,
            pid: listener.pid,
            process_name,
            protocol,
            kind,
            worktree: owner.map(|(i, _)| trees[i].shown.to_string_lossy().into_owned()),
            evidence: owner.map(|(_, e)| e),
            url,
            advertised: printed.is_some(),
        });
    }

    let rank = |k: PortKind| match k {
        PortKind::Workspace => 0,
        PortKind::Container => 1,
        PortKind::External => 2,
    };
    ports.sort_by(|a, b| {
        rank(a.kind)
            .cmp(&rank(b.kind))
            .then(a.port.cmp(&b.port))
            .then_with(|| a.connect_host.cmp(&b.connect_host))
    });
    ports.truncate(PORT_CAP);
    ports
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn listener(host: &str, port: u16, pid: Option<u32>) -> Listener {
        Listener {
            bind_host: host.into(),
            port,
            pid,
        }
    }

    fn proc(pid: u32, ppid: Option<u32>, name: &str, cmd: &str, cwd: Option<&str>) -> Proc {
        Proc {
            pid,
            ppid,
            name: name.into(),
            cmd: cmd.into(),
            cwd: cwd.map(PathBuf::from),
            start: None,
        }
    }

    fn none(_: &Path, _: u16) -> Option<String> {
        None
    }

    fn run(
        listeners: &[Listener],
        procs: &[Proc],
        roots: &[PtyRoot],
        trees: &[&str],
    ) -> Vec<WorkspacePort> {
        let trees: Vec<PathBuf> = trees.iter().map(PathBuf::from).collect();
        attribute_with(listeners, procs, roots, &trees, &none, false)
    }

    #[test]
    fn a_terminal_beats_the_cwd_and_the_cwd_beats_the_command() {
        let procs = [
            proc(10, None, "zsh", "zsh", Some("/w/a")),
            proc(11, Some(10), "node", "node server.js", Some("/w/b")),
            proc(20, None, "node", "node server.js", Some("/w/b/app")),
            proc(30, None, "node", "node /w/c/server.js", Some("/elsewhere")),
        ];
        let roots = [PtyRoot {
            pid: 10,
            worktree: "/w/a".into(),
        }];
        let ports = run(
            &[
                listener("*", 1111, Some(11)),
                listener("*", 2222, Some(20)),
                listener("*", 3333, Some(30)),
            ],
            &procs,
            &roots,
            &["/w/a", "/w/b", "/w/c"],
        );
        let at = |port: u16| ports.iter().find(|p| p.port == port).unwrap();
        assert_eq!(
            (at(1111).worktree.as_deref(), at(1111).evidence),
            (Some("/w/a"), Some(PortEvidence::Terminal))
        );
        assert_eq!(
            (at(2222).worktree.as_deref(), at(2222).evidence),
            (Some("/w/b"), Some(PortEvidence::Cwd))
        );
        assert_eq!(
            (at(3333).worktree.as_deref(), at(3333).evidence),
            (Some("/w/c"), Some(PortEvidence::Command))
        );
        assert!(ports.iter().all(|p| p.kind == PortKind::Workspace));
    }

    #[test]
    fn the_deepest_worktree_wins_for_a_cwd() {
        let procs = [proc(5, None, "node", "node", Some("/w/a/nested/src"))];
        let ports = run(
            &[listener("127.0.0.1", 3000, Some(5))],
            &procs,
            &[],
            &["/w/a", "/w/a/nested"],
        );
        assert_eq!(ports[0].worktree.as_deref(), Some("/w/a/nested"));
    }

    #[test]
    fn a_path_match_needs_a_boundary() {
        let procs = [
            proc(5, None, "node", "node /a/wt2/run.js", Some("/a/wt2")),
            proc(6, None, "node", "node /a/wt/run.js --x=/a/wt", Some("/x")),
            proc(7, None, "node", "node /home/a/wt/run.js", Some("/x")),
        ];
        let ports = run(
            &[
                listener("*", 1, Some(5)),
                listener("*", 2, Some(6)),
                listener("*", 3, Some(7)),
            ],
            &procs,
            &[],
            &["/a/wt"],
        );
        let at = |port: u16| ports.iter().find(|p| p.port == port).unwrap();
        assert_eq!(at(1).kind, PortKind::External);
        assert_eq!(at(2).evidence, Some(PortEvidence::Command));
        assert_eq!(at(3).kind, PortKind::External);
    }

    #[test]
    fn windows_paths_compare_by_slash_and_case() {
        assert_eq!(norm_with(r"C:\Users\Me\Repo\", true), "c:/users/me/repo");
        assert_eq!(norm_with(r"\\?\C:\Repo", true), "c:/repo");
        assert_eq!(norm_with(r"C:\Repo", false), "C:/Repo");
        let procs = [proc(
            5,
            None,
            "node.exe",
            r#""C:\Program Files\node\node.exe" c:\users\me\repo\server.js"#,
            Some(r"c:\USERS\me\repo\app"),
        )];
        let trees = vec![PathBuf::from(r"C:\Users\Me\Repo")];
        let ports = attribute_with(
            &[listener("0.0.0.0", 5173, Some(5))],
            &procs,
            &[],
            &trees,
            &none,
            true,
        );
        assert_eq!(ports[0].evidence, Some(PortEvidence::Cwd));
        assert_eq!(ports[0].worktree.as_deref(), Some(r"C:\Users\Me\Repo"));
    }

    #[test]
    fn the_ancestor_walk_stops_at_a_cycle_and_at_the_depth_cap() {
        // 1 -> 2 -> 1: no root, no hang.
        let looped = [
            proc(1, Some(2), "a", "", None),
            proc(2, Some(1), "b", "", None),
        ];
        let roots = [PtyRoot {
            pid: 99,
            worktree: "/w/a".into(),
        }];
        let ports = run(&[listener("*", 1, Some(1))], &looped, &roots, &["/w/a"]);
        assert_eq!(ports[0].kind, PortKind::External);

        // A chain with the root 64 parents up is found; 65 is not.
        let chain = |len: u32| -> Vec<Proc> {
            (1..=len + 1)
                .map(|pid| proc(pid, (pid <= len).then_some(pid + 1), "n", "", None))
                .collect()
        };
        let roots = [PtyRoot {
            pid: 65,
            worktree: "/w/a".into(),
        }];
        let near = run(&[listener("*", 1, Some(1))], &chain(64), &roots, &["/w/a"]);
        assert_eq!(near[0].evidence, Some(PortEvidence::Terminal));
        let roots = [PtyRoot {
            pid: 66,
            worktree: "/w/a".into(),
        }];
        let far = run(&[listener("*", 1, Some(1))], &chain(65), &roots, &["/w/a"]);
        assert_eq!(far[0].kind, PortKind::External);
    }

    #[test]
    fn a_terminal_counts_only_inside_a_queried_worktree() {
        let wts = [PathBuf::from("/w/a"), PathBuf::from("/w/b")];
        let at = |w: &str| PtyRoot {
            pid: 1,
            worktree: PathBuf::from(w),
        };
        assert!(has_terminal(&[at("/w/a")], &wts));
        assert!(has_terminal(&[at("/w/b/pkg")], &wts));
        assert!(!has_terminal(&[at("/w/ab")], &wts));
        assert!(!has_terminal(&[at("/elsewhere")], &wts));
        assert!(!has_terminal(&[], &wts));
        assert!(!has_terminal(&[at("/w/a")], &[]));
    }

    #[test]
    fn a_terminal_outside_every_worktree_owns_nothing() {
        let procs = [proc(11, Some(10), "node", "node", None)];
        let roots = [PtyRoot {
            pid: 10,
            worktree: "/other".into(),
        }];
        let ports = run(&[listener("*", 1, Some(11))], &procs, &roots, &["/w/a"]);
        assert_eq!(ports[0].kind, PortKind::External);
    }

    #[test]
    fn unmatched_ports_are_container_or_external() {
        assert!(is_container("com.docker.backend", ""));
        assert!(is_container("com.container.helper", ""));
        assert!(is_container("containerd", ""));
        assert!(is_container("x", "/usr/bin/containerd-shim --id 1"));
        assert!(is_container("java", "java -jar com.acme.api.backend"));
        assert!(!is_container("node", "node server.js"));
        assert!(!is_container("postgres", "postgres -D data"));

        let procs = [
            proc(1, None, "com.docker.backend", "", None),
            proc(2, None, "postgres", "postgres", None),
        ];
        let ports = run(
            &[
                listener("*", 8080, Some(1)),
                listener("*", 5432, Some(2)),
                listener("*", 9999, None),
            ],
            &procs,
            &[],
            &["/w/a"],
        );
        let kinds: Vec<_> = ports.iter().map(|p| (p.port, p.kind)).collect();
        assert_eq!(
            kinds,
            vec![
                (8080, PortKind::Container),
                (5432, PortKind::External),
                (9999, PortKind::External),
            ]
        );
    }

    #[test]
    fn duplicates_collapse_and_hosts_map_to_localhost() {
        let procs = [proc(1, None, "node", "node", None)];
        let ports = run(
            &[
                listener("0.0.0.0", 3000, Some(1)),
                listener("::", 3000, Some(1)),
                listener("*", 3000, Some(1)),
                listener("::1", 3000, Some(1)),
                listener("192.168.1.5", 3000, Some(1)),
            ],
            &procs,
            &[],
            &[],
        );
        let ids: Vec<_> = ports.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["192.168.1.5:3000:1", "::1:3000:1", "localhost:3000:1"]
        );
        assert_eq!(ports[1].url, "http://[::1]:3000");
        assert_eq!(ports[2].connect_host, "localhost");
        assert_eq!(ports[2].bind_host, "0.0.0.0");
    }

    #[test]
    fn ports_sort_by_kind_then_port_then_host_and_are_capped() {
        let procs = [
            proc(1, None, "node", "node", Some("/w/a")),
            proc(2, None, "postgres", "postgres", None),
        ];
        let ports = run(
            &[
                listener("*", 9000, Some(2)),
                listener("*", 4000, Some(1)),
                listener("*", 3000, Some(1)),
            ],
            &procs,
            &[],
            &["/w/a"],
        );
        let order: Vec<_> = ports.iter().map(|p| p.port).collect();
        assert_eq!(order, vec![3000, 4000, 9000]);

        let many: Vec<Listener> = (1..=300).map(|p| listener("*", p, None)).collect();
        let capped = run(&many, &[], &[], &[]);
        assert_eq!(capped.len(), PORT_CAP);
        assert_eq!(capped[0].port, 1);
    }

    #[test]
    fn the_protocol_is_guessed_by_port_and_a_printed_url_overrides_it() {
        assert_eq!(guess_protocol(443), PortProtocol::Https);
        assert_eq!(guess_protocol(8443), PortProtocol::Https);
        for port in [80, 3000, 3001, 4200, 5000, 5173, 5174, 8000, 8080, 8888] {
            assert_eq!(guess_protocol(port), PortProtocol::Http, "{port}");
        }
        assert_eq!(guess_protocol(5432), PortProtocol::Unknown);

        let procs = [proc(1, None, "node", "node", Some("/w/a"))];
        let trees = vec![PathBuf::from("/w/a")];
        let lookup = |w: &Path, port: u16| {
            (w == Path::new("/w/a") && port == 5432).then(|| "https://db.local:5432".to_owned())
        };
        let ports = attribute_with(
            &[listener("*", 5432, Some(1)), listener("*", 443, Some(1))],
            &procs,
            &[],
            &trees,
            &lookup,
            false,
        );
        let at = |port: u16| ports.iter().find(|p| p.port == port).unwrap();
        assert_eq!(at(5432).protocol, PortProtocol::Https);
        assert_eq!(at(5432).url, "https://db.local:5432");
        assert!(at(5432).advertised);
        assert_eq!(at(443).url, "https://localhost:443");
        assert!(!at(443).advertised);
        let unknown = run(&[listener("*", 5432, None)], &[], &[], &[]);
        assert_eq!(unknown[0].url, "http://localhost:5432");
        assert_eq!(unknown[0].protocol, PortProtocol::Unknown);
    }
}
