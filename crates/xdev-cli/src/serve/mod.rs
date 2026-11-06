//! `xdev serve`: a headless xdev-link host. A paired xDev desktop lists the
//! projects given here, starts a shell or an agent in one, and watches its
//! output, over the same `peer/1` calls a desktop host answers.
//!
//! Auth is always on: a peer connects with a stored key (Noise IK) or pairs
//! with `--pair`, the code and a `y` on stdin. Nothing here logs a code, a
//! key, the SAS, the offer link or terminal bytes.

use std::io::{BufReader, Write};
use std::ops::RangeInclusive;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use clap::{Parser, ValueEnum};
use xdev_link::identity::KEY_PERMS;
use xdev_link::server::{CONFIRM_MS, Window};
use xdev_link::{
    Clock, Discovery, FileKeyStore, Handle, HostKey, HostOpts, LinkBind, LinkError, LinkEvent,
    ListenCfg, Listener, PeerRole, PeerStore, SystemClock, net,
};

use host::{Say, ServeHost};
use projects::Projects;

pub mod host;
pub mod log;
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

/// What wakes the serve loop: a link event, or Ctrl+C / SIGTERM.
pub enum Wake {
    Link(LinkEvent),
    Stop,
}

/// A started host: what the loop answers and shutdown tears down.
pub struct Running {
    pub serve: Arc<ServeHost>,
    pub handle: Handle,
    pub window: Window,
    pub answers: Arc<pair::Answers>,
    /// The role a computer paired in this run gets.
    pub role: PeerRole,
    pub say: Say,
    /// Where the pairing question goes: stdout.
    pub out: Arc<Mutex<dyn Write + Send>>,
    pub confirm_wait: Duration,
}

impl Running {
    /// Answers link events until `Wake::Stop` or every sender is gone, then
    /// shuts down.
    pub fn serve(self, rx: Receiver<Wake>) {
        while let Ok(wake) = rx.recv() {
            match wake {
                Wake::Stop => break,
                Wake::Link(ev) => self.on_event(ev),
            }
        }
        self.shutdown();
    }

    fn on_event(&self, ev: LinkEvent) {
        if let Some(line) = log::event(&ev) {
            (self.say)(line);
        }
        if let LinkEvent::PairRequest {
            request_id,
            name,
            kind,
            sas,
            ..
        } = ev
        {
            // On a thread of its own: the loop keeps logging while the
            // operator reads the SAS.
            let host = self.handle.host().clone();
            let answers = self.answers.clone();
            let out = self.out.clone();
            let (role, wait) = (self.role, self.confirm_wait);
            std::thread::spawn(move || {
                let mut out = out.lock().unwrap_or_else(PoisonError::into_inner);
                pair::answer(
                    &host,
                    &answers,
                    &mut *out,
                    &request_id,
                    &name,
                    kind,
                    &sas,
                    role,
                    wait,
                );
            });
        }
    }

    /// Ruling 14: the pairing window closes, attached peers get
    /// `term.closed {reason: "host_stopped"}`, every PTY is killed and
    /// waited for (5 s each), then the listener stops.
    pub fn shutdown(self) {
        pair::close(&self.window);
        self.serve.terms().kill_all();
        self.handle.stop();
        (self.say)("stopped".to_owned());
    }
}

/// `xdev serve`. Returns once stopped; a second interrupt exits 130 at once.
pub fn run(args: ServeArgs, data_dir: &Path) -> Result<crate::Outcome, &'static str> {
    let dir = data_dir.join("serve");
    let store = Arc::new(PeerStore::open(&dir.join("peers.json")).map_err(|e| e.code())?);
    if args.peers {
        for p in store.list() {
            println!("{}\t{}\t{}", p.id, p.name, pair::role_name(p.role));
        }
        return Ok(crate::Outcome::Ok);
    }
    if let Some(id) = &args.forget {
        return match store.remove(id).map_err(|e| e.code())? {
            true => Ok(crate::Outcome::Ok),
            false => Err("no_peer"),
        };
    }
    let cwd = std::env::current_dir().map_err(|_| "io")?;
    let plan = check(&args, &store, &cwd)?;
    let projects = Projects::from_paths(&plan.projects)?;
    let key = HostKey::load_or_create(&FileKeyStore::new(dir.join("host-key")))
        .map_err(|e| key_code(&e))?;
    let key = Arc::new(key);
    let ip = net::bind_ip(plan.bind).ok_or("port")?;
    let name = host_name();
    let say = log::stderr();
    let data = data_dir.to_path_buf();
    let resolve: host::Resolve = Arc::new(move |id, prompt| host::resolve_in(&data, id, prompt));
    let serve = ServeHost::new(
        name.clone(),
        key.host_id(),
        projects,
        resolve,
        say.clone(),
        Arc::new(SystemClock),
    );
    let (link_tx, link_rx) = channel();
    let window = Window::default();
    let handle = Listener::start_with(
        ListenCfg {
            bind: plan.bind,
            port_range: plan.ports.clone(),
            ..ListenCfg::default()
        },
        key.clone(),
        store,
        window.clone(),
        serve.clone(),
        link_tx,
        HostOpts::default(),
    )
    .map_err(|e| listen_code(&e))?;
    serve.set_host(handle.host());
    let port = handle.port();
    say("started".to_owned());
    println!("listening on {ip}:{port}");
    let answers = if plan.pair {
        let candidates = net::candidates(plan.bind, port)
            .iter()
            .map(ToString::to_string)
            .collect();
        let (code, link) = pair::open(
            &window,
            &name,
            SystemClock.now_ms(),
            key.public(),
            candidates,
        )
        .map_err(|e| e.code())?;
        println!("{code}");
        println!("{link}");
        pair::Answers::spawn(BufReader::new(std::io::stdin()))
    } else {
        // Nobody can pair: every question would be refused.
        pair::Answers::from_lines(channel().1)
    };
    let _discovery = plan.announce.then(|| {
        Discovery::start(&key.host_id(), port, plan.bind)
            .inspect_err(|e| say(format!("announce failed {}", e.code())))
            .ok()
    });
    let (tx, rx) = channel();
    let events = tx.clone();
    std::thread::spawn(move || {
        while let Ok(ev) = link_rx.recv() {
            if events.send(Wake::Link(ev)).is_err() {
                break;
            }
        }
    });
    let stopping = AtomicBool::new(false);
    ctrlc::set_handler(move || {
        if stopping.swap(true, Ordering::SeqCst) {
            std::process::exit(130);
        }
        let _ = tx.send(Wake::Stop);
    })
    .map_err(|_| "io")?;
    Running {
        serve,
        handle,
        window,
        answers: Arc::new(answers),
        role: plan.role,
        say,
        out: Arc::new(Mutex::new(std::io::stdout())),
        confirm_wait: Duration::from_millis(CONFIRM_MS),
    }
    .serve(rx);
    Ok(crate::Outcome::Ok)
}

/// A key file others may read is `serve_key_perms` (ruling 11).
fn key_code(e: &LinkError) -> &'static str {
    match e {
        LinkError::Io(detail) if detail == KEY_PERMS => "serve_key_perms",
        e => e.code(),
    }
}

fn listen_code(e: &LinkError) -> &'static str {
    match e {
        LinkError::Port => "port",
        e => e.code(),
    }
}

/// What a desktop shows for this host: the machine's name.
fn host_name() -> String {
    ["COMPUTERNAME", "HOSTNAME"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .chain(std::fs::read_to_string("/etc/hostname").ok())
        .map(|n| n.trim().to_owned())
        .find(|n| !n.is_empty())
        .unwrap_or_else(|| "xdev serve".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::serve::host::tests::{join, world};
    use serde_json::{Value, json};

    const T: Duration = Duration::from_secs(5);

    /// Ruling 14 in process: a `Stop` (what Ctrl+C sends) closes the window,
    /// ends the PTYs and the links, and logs `stopped`.
    #[test]
    fn stop_shuts_down() {
        let w = world();
        let op = join(&w, "op", PeerRole::Operator);
        let term = op
            .call(
                "agent.start",
                json!({ "project_id": w.project, "profile_id": "shell" }),
                T,
            )
            .unwrap();
        let id = term["id"].as_str().unwrap().to_owned();
        op.call("term.attach", json!({ "id": id, "stream": 3 }), T)
            .unwrap();
        pair::open(
            &w.window,
            "box",
            SystemClock.now_ms(),
            w.key.public(),
            vec![],
        )
        .unwrap();

        let (said_tx, said) = channel();
        let said_tx = Mutex::new(said_tx);
        let say: Say = Arc::new(move |line| {
            let _ = said_tx
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .send(line);
        });
        let serve = w.serve.clone();
        let window = w.window.clone();
        let running = Running {
            serve: w.serve,
            handle: w.handle,
            window: w.window,
            answers: Arc::new(pair::Answers::from_lines(channel().1)),
            role: PeerRole::Operator,
            say,
            out: Arc::new(Mutex::new(Vec::<u8>::new())),
            confirm_wait: T,
        };
        let (tx, rx) = channel();
        let (done_tx, done) = channel();
        std::thread::spawn(move || {
            running.serve(rx);
            let _ = done_tx.send(());
        });
        tx.send(Wake::Link(LinkEvent::Disconnected {
            peer_id: "p1".into(),
        }))
        .unwrap();
        tx.send(Wake::Stop).unwrap();
        done.recv_timeout(T).expect("stopped within 5 s");

        assert_eq!(said.recv_timeout(T).unwrap(), "disconnected p1");
        assert_eq!(said.recv_timeout(T).unwrap(), "stopped");
        assert!(window.lock().unwrap().is_none(), "pairing window closed");
        let listed = serve.terms().list();
        assert!(
            listed
                .iter()
                .all(|t| t.state != xdev_link::PeerTermState::Running),
            "no PTY left running"
        );
        assert!(
            op.call("terms.list", Value::Null, T).is_err(),
            "link closed"
        );
    }

    #[test]
    fn error_codes_for_the_cli() {
        assert_eq!(
            key_code(&LinkError::Io(KEY_PERMS.into())),
            "serve_key_perms"
        );
        assert_eq!(listen_code(&LinkError::Port), "port");
        assert!(!host_name().is_empty());
    }

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
