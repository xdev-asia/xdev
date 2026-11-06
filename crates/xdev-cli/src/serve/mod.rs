//! `xdev serve`: a headless xdev-link host. A paired xDev desktop lists the
//! projects given here, starts a shell or an agent in one, and watches its
//! output, over the same `peer/1` calls a desktop host answers.
//!
//! Auth is always on: a peer connects with a stored key (Noise IK) or pairs
//! with `--pair`, the code and a `y` on stdin. Nothing here logs a code, a
//! key, the SAS, the offer link or terminal bytes.

use std::ops::RangeInclusive;
use std::path::{Path, PathBuf};

use clap::{Parser, ValueEnum};
use xdev_link::{LinkBind, PeerRole, PeerStore};

pub mod host;
pub mod pair;
pub mod projects;
pub mod terms;

/// The first port tried; up to 15 more after it, as on the desktop.
pub const PORT: u16 = 47821;
const PORT_SPAN: u16 = 15;

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum Bind {
    Localhost,
    Lan,
    Tailscale,
}

impl Bind {
    fn link(self) -> LinkBind {
        match self {
            Bind::Localhost => LinkBind::Localhost,
            Bind::Lan => LinkBind::Lan,
            Bind::Tailscale => LinkBind::Tailscale,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum Role {
    Viewer,
    Operator,
    Admin,
}

impl Role {
    fn peer(self) -> PeerRole {
        match self {
            Role::Viewer => PeerRole::Viewer,
            Role::Operator => PeerRole::Operator,
            Role::Admin => PeerRole::Admin,
        }
    }
}

#[derive(Debug, Parser)]
#[command(name = "serve")]
pub struct ServeArgs {
    /// A folder to serve; repeat for more. Default: the current folder when
    /// it is a git repo.
    #[arg(long = "project", value_name = "PATH")]
    pub projects: Vec<PathBuf>,
    /// Where to listen.
    #[arg(long, value_enum, default_value_t = Bind::Localhost)]
    pub bind: Bind,
    /// The first port to try; the next 15 follow. `0` takes any free port.
    #[arg(long, default_value_t = PORT)]
    pub port: u16,
    /// Open a pairing window and print its code and link.
    #[arg(long)]
    pub pair: bool,
    /// The role a computer paired in this run gets.
    #[arg(long, value_enum, default_value_t = Role::Operator)]
    pub role: Role,
    /// Do not announce on the LAN (mDNS).
    #[arg(long)]
    pub no_announce: bool,
    /// Print `id<TAB>name<TAB>role` for each paired computer and exit.
    #[arg(long, conflicts_with_all = ["forget", "pair"])]
    pub peers: bool,
    /// Remove one paired computer and exit.
    #[arg(long, value_name = "PEER_ID", conflicts_with = "pair")]
    pub forget: Option<String>,
}

/// What a run serves, once the startup checks pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub projects: Vec<PathBuf>,
    pub bind: LinkBind,
    pub ports: RangeInclusive<u16>,
    pub pair: bool,
    pub role: PeerRole,
    pub announce: bool,
}

/// The startup checks (rulings 4, 7, 9): a project to serve, and someone
/// who could connect when the port is reachable from elsewhere.
pub fn check(args: &ServeArgs, store: &PeerStore, cwd: &Path) -> Result<Plan, &'static str> {
    let projects = if args.projects.is_empty() {
        if !cwd.join(".git").exists() {
            return Err("serve_no_project");
        }
        vec![cwd.to_path_buf()]
    } else {
        args.projects.clone()
    };
    let bind = args.bind.link();
    if bind != LinkBind::Localhost && !args.pair && store.list().is_empty() {
        return Err("serve_no_peers");
    }
    let ports = if args.port == 0 {
        0..=0
    } else {
        args.port..=args.port.saturating_add(PORT_SPAN)
    };
    Ok(Plan {
        projects,
        bind,
        ports,
        pair: args.pair,
        role: args.role.peer(),
        // mDNS does not cross a tailnet, and nobody nearby sees localhost.
        announce: bind == LinkBind::Lan && !args.no_announce,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<ServeArgs, clap::Error> {
        let mut argv = vec!["serve"];
        argv.extend_from_slice(args);
        ServeArgs::try_parse_from(argv)
    }

    struct Dirs {
        _tmp: tempfile::TempDir,
        repo: PathBuf,
        plain: PathBuf,
        store: PeerStore,
    }

    fn dirs() -> Dirs {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        let plain = tmp.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        let store = PeerStore::open(&tmp.path().join("peers.json")).unwrap();
        Dirs {
            _tmp: tmp,
            repo,
            plain,
            store,
        }
    }

    #[test]
    fn defaults() {
        let a = parse(&[]).unwrap();
        assert_eq!(a.bind, Bind::Localhost);
        assert_eq!(a.port, 47821);
        assert_eq!(a.role, Role::Operator);
        assert!(!a.no_announce && !a.pair && !a.peers);
        let d = dirs();
        let plan = check(&a, &d.store, &d.repo).unwrap();
        assert_eq!(plan.ports, 47821..=47836);
        assert_eq!(plan.bind, LinkBind::Localhost);
        assert_eq!(plan.role, PeerRole::Operator);
        assert!(!plan.announce, "never on localhost");
        assert_eq!(plan.projects, vec![d.repo.clone()]);
    }

    #[test]
    fn no_flag_turns_auth_off() {
        assert!(parse(&["--no-auth"]).is_err());
        assert!(parse(&["--insecure"]).is_err());
        assert!(parse(&["--bind", "wan"]).is_err());
        assert!(parse(&["--role", "none"]).is_err());
    }

    #[test]
    fn reachable_port_needs_a_peer_or_pairing() {
        let d = dirs();
        let lan = parse(&["--bind", "lan"]).unwrap();
        assert_eq!(check(&lan, &d.store, &d.repo), Err("serve_no_peers"));
        let ts = parse(&["--bind", "tailscale"]).unwrap();
        assert_eq!(check(&ts, &d.store, &d.repo), Err("serve_no_peers"));
        let pair = parse(&["--bind", "lan", "--pair"]).unwrap();
        assert!(check(&pair, &d.store, &d.repo).unwrap().announce);
        let quiet = parse(&["--bind", "lan", "--pair", "--no-announce"]).unwrap();
        assert!(!check(&quiet, &d.store, &d.repo).unwrap().announce);
        // Loopback with nobody paired serves nobody, which is harmless.
        assert!(check(&parse(&[]).unwrap(), &d.store, &d.repo).is_ok());
        let peer = xdev_link::StoredPeer::new("mac", xdev_link::PeerKind::Desktop, &[1; 32], 1);
        d.store.add(peer).unwrap();
        assert!(check(&lan, &d.store, &d.repo).is_ok());
    }

    #[test]
    fn project_from_flag_or_git_cwd() {
        let d = dirs();
        assert_eq!(
            check(&parse(&[]).unwrap(), &d.store, &d.plain),
            Err("serve_no_project")
        );
        let p = d.plain.to_str().unwrap();
        let plan = check(&parse(&["--project", p]).unwrap(), &d.store, &d.plain).unwrap();
        assert_eq!(plan.projects, vec![d.plain.clone()]);
    }

    #[test]
    fn port_zero_and_role() {
        let d = dirs();
        let a = parse(&["--port", "0", "--role", "admin"]).unwrap();
        let plan = check(&a, &d.store, &d.repo).unwrap();
        assert_eq!(plan.ports, 0..=0);
        assert_eq!(plan.role, PeerRole::Admin);
        let top = parse(&["--port", "65530"]).unwrap();
        assert_eq!(check(&top, &d.store, &d.repo).unwrap().ports, 65530..=65535);
    }
}
