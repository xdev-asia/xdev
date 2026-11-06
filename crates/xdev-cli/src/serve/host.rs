//! What `xdev serve` answers a paired computer: `peer/1`, the method set and
//! JSON shapes of the desktop host (`apps/desktop/src-tauri/src/peers/host.rs`).
//!
//! Every action runs the same checks as there, in order: the role, the rate
//! limit, then the action. There is no `confirm_each`; the role chosen at
//! pairing is the whole grant.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError, Weak};

use base64::Engine as _;
use serde_json::{Value, json};
use xdev_link::{Clock, Host, Limits, PeerCtx, PeerRole, PeerTerm, RpcError, Serve};

use super::projects::{Project, Projects};
use super::terms::{self, Frame, Start, Terms, Watcher};

pub const PROTO: &str = "peer/1";
/// The most one `term.write` carries.
pub const WRITE_MAX: usize = 4096;
/// Output bytes per stream frame, after the seq header.
const FRAME_BYTES: usize = 16 * 1024;
const SEQ_LEN: usize = 8;

/// The methods served and the least role each needs. Keep in line with
/// `apps/desktop/src-tauri/src/peers/host.rs::call`; `mail.handoff` is a
/// follow-up and answers `unsupported` here.
pub const METHODS: &[(&str, PeerRole)] = &[
    ("hello", PeerRole::None),
    ("bye", PeerRole::None),
    ("projects.list", PeerRole::Viewer),
    ("terms.list", PeerRole::Viewer),
    ("term.attach", PeerRole::Viewer),
    ("term.detach", PeerRole::Viewer),
    ("term.write", PeerRole::Operator),
    ("agent.start", PeerRole::Operator),
    ("shell.open", PeerRole::Admin),
    ("term.kill", PeerRole::Admin),
];

/// One line for the log; never a code, a key or terminal bytes.
pub type Say = Arc<dyn Fn(String) + Send + Sync>;

/// A program to run for a profile id: `shell`, `shell:<id>` or an agent
/// profile, with its first prompt. The error is a `LaunchError` code.
pub type Resolve = Arc<dyn Fn(&str, Option<&str>) -> Result<Launched, &'static str> + Send + Sync>;

pub struct Launched {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, std::ffi::OsString)>,
    /// Typed into the PTY once it runs.
    pub prompt_after: Option<String>,
}

/// A peer's watch on one term.
struct Sub {
    term: String,
    wid: u64,
}

pub struct ServeHost {
    name: String,
    host_id: String,
    projects: Projects,
    terms: Terms,
    resolve: Resolve,
    say: Say,
    clock: Arc<dyn Clock>,
    host: OnceLock<Weak<Host>>,
    limits: Mutex<HashMap<String, Limits>>,
    subs: Mutex<HashMap<(String, u32), Sub>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn bad() -> RpcError {
    RpcError::code("bad_request")
}

fn str_param<'a>(p: &'a Value, k: &str) -> Result<&'a str, RpcError> {
    p.get(k)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(bad)
}

impl ServeHost {
    pub fn new(
        name: String,
        host_id: String,
        projects: Projects,
        resolve: Resolve,
        say: Say,
        clock: Arc<dyn Clock>,
    ) -> Arc<ServeHost> {
        let exit_say = say.clone();
        let terms = Terms::new(Arc::new(move |id: &str, code: Option<i32>| {
            let code = code.map_or_else(|| "none".to_owned(), |c| c.to_string());
            exit_say(format!("term {id} exited {code}"));
        }));
        Arc::new(ServeHost {
            name,
            host_id,
            projects,
            terms,
            resolve,
            say,
            clock,
            host: OnceLock::new(),
            limits: Mutex::default(),
            subs: Mutex::default(),
        })
    }

    /// The listener's host, for the links `term.attach` streams on. Set once,
    /// right after the listener starts.
    pub fn set_host(&self, host: &Arc<Host>) {
        let _ = self.host.set(Arc::downgrade(host));
    }

    pub fn terms(&self) -> &Terms {
        &self.terms
    }

    pub fn hello(&self, role: PeerRole) -> Value {
        json!({
            "proto": PROTO,
            "name": self.name,
            "hostId": self.host_id,
            "yourRole": role,
        })
    }

    fn dispatch(&self, peer: &PeerCtx, m: &str, p: Value) -> Result<Value, RpcError> {
        match m {
            "hello" => Ok(self.hello(peer.role)),
            "bye" => Ok(Value::Null),
            "projects.list" => {
                peer.require(PeerRole::Viewer)?;
                Ok(json!(self.projects.list(peer.role)))
            }
            "terms.list" => {
                peer.require(PeerRole::Viewer)?;
                Ok(json!(self.terms.list()))
            }
            "term.attach" => {
                peer.require(PeerRole::Viewer)?;
                self.attach(peer, &p)
            }
            "term.detach" => {
                peer.require(PeerRole::Viewer)?;
                self.detach(peer, &p);
                Ok(Value::Null)
            }
            "term.write" => {
                peer.require(PeerRole::Operator)?;
                self.write(peer, &p)
            }
            "agent.start" => {
                peer.require(PeerRole::Operator)?;
                let project = self.project(&p)?;
                let profile = str_param(&p, "profile_id")?.to_owned();
                let prompt = p
                    .get("prompt")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty());
                self.limit(peer, Limits::allow_rpc)?;
                let title = format!("{} (from {})", profile, peer.name);
                let term = self.open(project, &profile, prompt, title)?;
                Ok(json!(term))
            }
            "shell.open" => {
                peer.require(PeerRole::Admin)?;
                let project = self.project(&p)?;
                self.limit(peer, Limits::allow_rpc)?;
                let title = format!("shell (from {})", peer.name);
                let term = self.open(project, "shell", None, title)?;
                Ok(json!(term))
            }
            "term.kill" => {
                peer.require(PeerRole::Admin)?;
                let id = str_param(&p, "id")?;
                self.term(id)?;
                self.limit(peer, Limits::allow_rpc)?;
                self.terms.remove(id).map_err(RpcError::code)?;
                Ok(Value::Null)
            }
            _ => Err(RpcError::code("unsupported")),
        }
    }

    fn project(&self, p: &Value) -> Result<&Project, RpcError> {
        let id = str_param(p, "project_id")?;
        self.projects
            .get(id)
            .ok_or_else(|| RpcError::code("no_project"))
    }

    fn term(&self, id: &str) -> Result<PeerTerm, RpcError> {
        self.terms
            .list()
            .into_iter()
            .find(|t| t.id == id)
            .ok_or_else(|| RpcError::code("no_term"))
    }

    fn limit(&self, peer: &PeerCtx, allow: fn(&mut Limits) -> bool) -> Result<(), RpcError> {
        let mut limits = lock(&self.limits);
        let l = limits
            .entry(peer.peer_id.clone())
            .or_insert_with(|| Limits::new(self.clock.clone()));
        if allow(l) {
            Ok(())
        } else {
            Err(RpcError::code("rate_limited"))
        }
    }

    fn open(
        &self,
        project: &Project,
        profile: &str,
        prompt: Option<&str>,
        title: String,
    ) -> Result<PeerTerm, RpcError> {
        let launched = (self.resolve)(profile, prompt).map_err(RpcError::code)?;
        let shell = profile == "shell" || profile.starts_with("shell:");
        let term = self
            .terms
            .open(Start {
                program: launched.program,
                args: launched.args,
                env: launched.env,
                cwd: project.path.clone(),
                project_id: project.id.clone(),
                title,
                agent: (!shell).then(|| profile.to_owned()),
                input_after: launched.prompt_after.map(String::into_bytes),
            })
            .map_err(RpcError::code)?;
        (self.say)(format!("term {} started {profile}", term.id));
        Ok(term)
    }

    fn write(&self, peer: &PeerCtx, p: &Value) -> Result<Value, RpcError> {
        let id = str_param(p, "id")?;
        let data = base64::engine::general_purpose::STANDARD
            .decode(p.get("data_b64").and_then(Value::as_str).ok_or_else(bad)?)
            .map_err(|_| bad())?;
        if data.len() > WRITE_MAX {
            return Err(bad());
        }
        self.term(id)?;
        self.limit(peer, Limits::allow_input)?;
        self.terms.write(id, data).map_err(RpcError::code)?;
        Ok(Value::Null)
    }

    /// Starts sending term `id` to the caller on its `stream`, from `from_seq`.
    fn attach(&self, peer: &PeerCtx, p: &Value) -> Result<Value, RpcError> {
        let id = str_param(p, "id")?.to_owned();
        let stream = p
            .get("stream")
            .and_then(Value::as_u64)
            .and_then(|s| u32::try_from(s).ok())
            .ok_or_else(bad)?;
        let from_seq = p.get("from_seq").and_then(Value::as_u64).unwrap_or(0);
        let link = self
            .host
            .get()
            .and_then(Weak::upgrade)
            .and_then(|h| h.link(&peer.peer_id))
            .filter(|l| l.is_open())
            .ok_or_else(|| RpcError::code("peer_offline"))?;
        let key = (peer.peer_id.clone(), stream);
        if let Some(old) = lock(&self.subs).remove(&key) {
            self.terms.detach(&old.term, old.wid);
        }
        let term = id.clone();
        let watcher: Watcher = Box::new(move |f| match f {
            Frame::Output { seq, bytes } => {
                let mut at = seq;
                for chunk in bytes.chunks(FRAME_BYTES) {
                    let mut frame = Vec::with_capacity(SEQ_LEN + chunk.len());
                    frame.extend_from_slice(&at.to_be_bytes());
                    frame.extend_from_slice(chunk);
                    let _ = link.send_stream(stream, &frame);
                    at += chunk.len() as u64;
                }
            }
            Frame::Closed(reason) => {
                let _ = link.notify(
                    "term.closed",
                    json!({ "stream": stream, "id": term, "reason": reason }),
                );
            }
        });
        let (wid, _) = self
            .terms
            .attach(&id, from_seq, watcher)
            .map_err(RpcError::code)?;
        lock(&self.subs).insert(key, Sub { term: id, wid });
        Ok(json!({ "stream": stream, "cols": terms::COLS, "rows": terms::ROWS }))
    }

    fn detach(&self, peer: &PeerCtx, p: &Value) {
        let id = p.get("id").and_then(Value::as_str).unwrap_or_default();
        let stream = p.get("stream").and_then(Value::as_u64);
        self.drop_subs(|(pid, s), sub| {
            *pid == peer.peer_id
                && sub.term == id
                && stream.is_none_or(|want| want == u64::from(*s))
        });
    }

    fn drop_subs(&self, gone: impl Fn(&(String, u32), &Sub) -> bool) {
        let subs: Vec<Sub> = {
            let mut subs = lock(&self.subs);
            let keys: Vec<(String, u32)> = subs
                .iter()
                .filter(|(k, s)| gone(k, s))
                .map(|(k, _)| k.clone())
                .collect();
            keys.iter().filter_map(|k| subs.remove(k)).collect()
        };
        for s in subs {
            self.terms.detach(&s.term, s.wid);
        }
    }
}

impl Serve for ServeHost {
    fn call(&self, peer: &PeerCtx, m: &str, p: Value) -> Result<Value, RpcError> {
        let r = self.dispatch(peer, m, p);
        if let Err(e) = &r {
            (self.say)(format!("rpc {m} from {} failed {}", peer.peer_id, e.code));
        }
        r
    }

    fn on_stream(&self, _peer: &PeerCtx, _id: u32, _bytes: &[u8]) {}

    fn on_close(&self, peer: &PeerCtx) {
        self.drop_subs(|(pid, _), _| *pid == peer.peer_id);
    }
}

/// The launch of `id` the way the desktop builds it (`pty.rs`), without
/// account routing, hooks, resume or the policy gate (ruling 6).
pub fn resolve_in(
    data_dir: &Path,
    id: &str,
    prompt: Option<&str>,
) -> Result<Launched, &'static str> {
    use xdev_agent::{Context, LaunchError, Profile, Profiles, find_builtin, find_program};
    let profiles = Profiles::load(data_dir).map_err(|e| LaunchError::from(e).code())?;
    let accounts = xdev_ai::Registry::load(data_dir).map_err(|e| e.code())?;
    let shells = xdev_agent::list_shells(&[], &[]);
    let find = |profile: &Profile| match profile.cli {
        Some(cli) => find_builtin(cli),
        None => profile.program.as_deref().and_then(find_program),
    };
    let ctx = Context {
        profiles: &profiles,
        accounts: &accounts,
        shells: &shells,
        find: &find,
        account: None,
        prompt,
        wsl: false,
    };
    let launch = xdev_agent::resolve(id, &ctx).map_err(|e| e.code())?;
    let (program, args) = launch.command();
    Ok(Launched {
        program,
        args,
        env: launch.env,
        prompt_after: launch.prompt_after,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;
    use xdev_link::{
        Dialer, FakeClock, FakeDiscover, HostKey, HostOpts, LinkBind, LinkEvent, LinkOpts,
        ListenCfg, Listener, MemoryStore, NoRelay, PeerKind, PeerStore, StoredPeer, SystemClock,
    };

    const T: Duration = Duration::from_secs(5);

    pub(crate) fn noop_serve() -> Arc<dyn Serve> {
        struct Quiet;
        impl Serve for Quiet {
            fn call(&self, _: &PeerCtx, _: &str, _: Value) -> Result<Value, RpcError> {
                Err(RpcError::code("unsupported"))
            }
            fn on_stream(&self, _: &PeerCtx, _: u32, _: &[u8]) {}
            fn on_close(&self, _: &PeerCtx) {}
        }
        Arc::new(Quiet)
    }

    /// `shell` runs the platform shell, as the default shell would; the
    /// rest are not installed.
    fn fake_resolve() -> Resolve {
        Arc::new(|id: &str, _prompt: Option<&str>| {
            if id != "shell" {
                return Err("unknown_profile");
            }
            let (program, args) = if cfg!(windows) {
                ("cmd.exe", vec!["/d", "/q"])
            } else {
                ("/bin/sh", vec![])
            };
            Ok(Launched {
                program: program.into(),
                args: args.into_iter().map(String::from).collect(),
                env: Vec::new(),
                prompt_after: None,
            })
        })
    }

    pub(crate) struct World {
        pub dir: tempfile::TempDir,
        pub serve: Arc<ServeHost>,
        pub key: Arc<HostKey>,
        pub store: Arc<PeerStore>,
        pub handle: xdev_link::Handle,
        pub events: mpsc::Receiver<LinkEvent>,
        pub window: xdev_link::server::Window,
        pub project: String,
    }

    pub(crate) fn world() -> World {
        world_on(Arc::new(SystemClock))
    }

    /// A host whose links and limits read `clock`.
    pub(crate) fn world_on(clock: Arc<dyn Clock>) -> World {
        let dir = tempfile::tempdir().unwrap();
        let proj = dir.path().join("app");
        std::fs::create_dir_all(&proj).unwrap();
        let projects = Projects::from_paths(&[proj]).unwrap();
        let project = projects.list(PeerRole::Viewer)[0].id.clone();
        let key = Arc::new(HostKey::load_or_create(&MemoryStore::default()).unwrap());
        let store = Arc::new(PeerStore::open(&dir.path().join("peers.json")).unwrap());
        let serve = ServeHost::new(
            "box".into(),
            key.host_id(),
            projects,
            fake_resolve(),
            Arc::new(|_| {}),
            clock.clone(),
        );
        let (tx, events) = mpsc::channel();
        let window = xdev_link::server::Window::default();
        let handle = Listener::start_with(
            ListenCfg {
                bind: LinkBind::Localhost,
                port_range: 0..=0,
                ..ListenCfg::default()
            },
            key.clone(),
            store.clone(),
            window.clone(),
            serve.clone(),
            tx,
            HostOpts {
                link: LinkOpts {
                    clock,
                    ..LinkOpts::default()
                },
                ..HostOpts::default()
            },
        )
        .unwrap();
        serve.set_host(handle.host());
        World {
            dir,
            serve,
            key,
            store,
            handle,
            events,
            window,
            project,
        }
    }

    /// A desktop the host already knows with `role`, connected over IK.
    pub(crate) fn join(w: &World, name: &str, role: PeerRole) -> Arc<xdev_link::Link> {
        let key = Arc::new(HostKey::generate().unwrap());
        let mut known = StoredPeer::new(name, PeerKind::Desktop, &key.public(), 1);
        known.role = role;
        w.store.add(known).unwrap();
        dial(w, key, name).unwrap()
    }

    pub(crate) fn dial(
        w: &World,
        key: Arc<HostKey>,
        name: &str,
    ) -> Result<Arc<xdev_link::Link>, xdev_link::LinkError> {
        let mine = Arc::new(
            PeerStore::open(&w.dir.path().join(format!("{name}-{}.json", key.host_id()))).unwrap(),
        );
        let mut host = StoredPeer::new("box", PeerKind::Desktop, &w.key.public(), 1);
        host.addrs = vec![format!("127.0.0.1:{}", w.handle.port())];
        let mut dialer = Dialer::new(key, name, mine, noop_serve());
        dialer.handshake_timeout = T;
        dialer.connect(&host, &FakeDiscover::default(), &NoRelay)
    }

    fn code(r: Result<Value, RpcError>) -> String {
        r.expect_err("an error").code
    }

    fn ctx(role: PeerRole) -> PeerCtx {
        PeerCtx {
            peer_id: format!("peer-{role:?}"),
            name: "mac".into(),
            kind: PeerKind::Desktop,
            role,
            remote_pub: [1; 32],
        }
    }

    fn below(role: PeerRole) -> Option<PeerRole> {
        match role {
            PeerRole::None => None,
            PeerRole::Viewer => Some(PeerRole::None),
            PeerRole::Operator => Some(PeerRole::Viewer),
            PeerRole::Admin => Some(PeerRole::Operator),
        }
    }

    #[test]
    fn hello_over_ik() {
        let w = world();
        let link = join(&w, "mac", PeerRole::Operator);
        let v = link.call("hello", Value::Null, T).unwrap();
        assert_eq!(v["proto"], "peer/1");
        assert_eq!(v["hostId"], w.key.host_id());
        assert_eq!(v["yourRole"], "operator");
        assert_eq!(v["name"], "box");
        assert!(v.get("xid").is_none());
    }

    #[test]
    fn contract_names_and_roles() {
        let w = world();
        for &(m, role) in METHODS {
            // Empty params: past the role check, every method has an answer
            // of its own, never `unsupported`.
            let r = w.serve.dispatch(&ctx(role), m, json!({}));
            if let Err(e) = &r {
                assert_ne!(e.code, "unsupported", "{m}");
                assert_ne!(e.code, "peer_role", "{m} as {role:?}");
            }
            if let Some(low) = below(role) {
                assert_eq!(
                    code(w.serve.dispatch(&ctx(low), m, json!({}))),
                    "peer_role",
                    "{m} as {low:?}"
                );
            }
        }
        for m in ["mail.handoff", "term.resize", "fs.read"] {
            assert_eq!(
                code(w.serve.dispatch(&ctx(PeerRole::Admin), m, json!({}))),
                "unsupported"
            );
        }
    }

    #[test]
    fn role_cutoffs_over_the_wire() {
        let w = world();
        let viewer = join(&w, "viewer", PeerRole::Viewer);
        let operator = join(&w, "operator", PeerRole::Operator);
        let write = json!({ "id": "s1", "data_b64": "aGk=" });
        assert_eq!(
            code(viewer.call("term.write", write.clone(), T)),
            "peer_role"
        );
        assert_eq!(code(viewer.call("agent.start", json!({}), T)), "peer_role");
        assert_eq!(
            code(operator.call("term.kill", json!({ "id": "s1" }), T)),
            "peer_role"
        );
        assert_eq!(
            code(operator.call("shell.open", json!({ "project_id": w.project }), T)),
            "peer_role"
        );
        assert!(viewer.call("projects.list", Value::Null, T).is_ok());
    }

    #[test]
    fn bad_requests_and_missing_things() {
        let w = world();
        let op = join(&w, "op", PeerRole::Operator);
        let big = base64::engine::general_purpose::STANDARD.encode(vec![b'x'; WRITE_MAX + 1]);
        assert_eq!(
            code(op.call("term.write", json!({ "id": "s1", "data_b64": big }), T)),
            "bad_request"
        );
        assert_eq!(
            code(op.call("term.write", json!({ "id": "s1", "data_b64": "aGk=" }), T)),
            "no_term"
        );
        assert_eq!(
            code(op.call(
                "agent.start",
                json!({ "project_id": "0000000000000000", "profile_id": "shell" }),
                T
            )),
            "no_project"
        );
        assert_eq!(
            code(op.call("agent.start", json!({ "project_id": w.project }), T)),
            "bad_request"
        );
        assert_eq!(
            code(op.call(
                "agent.start",
                json!({ "project_id": w.project, "profile_id": "nope" }),
                T
            )),
            "unknown_profile"
        );
        assert_eq!(
            code(op.call("term.attach", json!({ "id": "s9", "stream": 1 }), T)),
            "no_term"
        );
        assert_eq!(code(op.call("mail.handoff", json!({}), T)), "unsupported");
    }

    #[test]
    fn a_burst_is_rate_limited() {
        // The clock stands still, so the 20/s bucket never refills.
        let w = world_on(Arc::new(FakeClock::new(1_000)));
        let v = join(&w, "v", PeerRole::Viewer);
        let limited = (0..25)
            .map(|_| v.call("projects.list", Value::Null, T))
            .filter(|r| matches!(r, Err(e) if e.code == "rate_limited"))
            .count();
        assert_eq!(limited, 5);
    }

    #[test]
    fn projects_path_only_for_admin() {
        let w = world();
        let v = join(&w, "v", PeerRole::Viewer);
        let a = join(&w, "a", PeerRole::Admin);
        let list = v.call("projects.list", Value::Null, T).unwrap();
        assert_eq!(list[0]["id"], w.project.as_str());
        assert_eq!(list[0]["name"], "app");
        assert!(list[0]["path"].is_null());
        let list = a.call("projects.list", Value::Null, T).unwrap();
        assert!(list[0]["path"].as_str().unwrap().ends_with("app"));
    }

    #[test]
    fn shell_runs_attaches_and_types() {
        let w = world();
        let op = join(&w, "op", PeerRole::Operator);
        let term = op
            .call(
                "agent.start",
                json!({ "project_id": w.project, "profile_id": "shell" }),
                T,
            )
            .unwrap();
        assert_eq!(term["state"], "running");
        assert_eq!(term["projectId"], w.project.as_str());
        assert!(term["agent"].is_null());
        let id = term["id"].as_str().unwrap().to_owned();
        let list = op.call("terms.list", Value::Null, T).unwrap();
        assert_eq!(list[0]["id"], id.as_str());
        assert_eq!(list[0]["projectId"], w.project.as_str());
        let att = op
            .call("term.attach", json!({ "id": id, "stream": 7 }), T)
            .unwrap();
        assert_eq!(att, json!({ "stream": 7, "cols": 120, "rows": 32 }));
        let data = base64::engine::general_purpose::STANDARD.encode(b"echo hi\r");
        op.call("term.write", json!({ "id": id, "data_b64": data }), T)
            .unwrap();
        op.call("term.detach", json!({ "id": id }), T).unwrap();
        // Operator cannot kill; the host stops what it started.
        assert_eq!(
            code(op.call("term.kill", json!({ "id": id }), T)),
            "peer_role"
        );
        assert!(w.serve.terms().kill_all());
    }

    #[test]
    fn admin_opens_a_shell_and_kills_it() {
        let w = world();
        let admin = join(&w, "admin", PeerRole::Admin);
        let term = admin
            .call("shell.open", json!({ "project_id": w.project }), T)
            .unwrap();
        let id = term["id"].as_str().unwrap().to_owned();
        assert_eq!(term["title"], "shell (from admin)");
        admin.call("term.kill", json!({ "id": id }), T).unwrap();
        let list = admin.call("terms.list", Value::Null, T).unwrap();
        assert_eq!(list, json!([]));
        assert_eq!(
            code(admin.call("term.kill", json!({ "id": id }), T)),
            "no_term"
        );
    }

    #[test]
    fn unknown_key_is_denied_before_hello() {
        let w = world();
        let stranger = Arc::new(HostKey::generate().unwrap());
        assert!(dial(&w, stranger, "stranger").is_err());
        assert!(w.store.list().is_empty());
    }
}
