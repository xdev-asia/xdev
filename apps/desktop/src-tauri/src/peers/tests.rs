//! Two cores, a host and a joiner, over in-memory pipes: no sockets, no
//! processes. The host core's clock is fake so `confirm_each` times out at
//! once.

use std::net::SocketAddr;
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde_json::{Value, json};
use xdev_link::mem::{MemConnect, pipe};
use xdev_link::server::serve_conn;
use xdev_link::{
    Connect, FakeClock, FakeDiscover, Host, HostKey, HostOpts, JoinTarget, LinkError, ListenCfg,
    Nearby, PeerRole, PeerStore, PeerTerm, PeerTermState, RpcError, SystemClock,
};

use super::host::{self, HostEnv, LocalProject};
use super::mail::{self, Route};
use super::{ACTION_WAIT, CALL_WAIT, Core, tap};

const T: Duration = Duration::from_secs(10);
const ADDR: &str = "10.0.0.1:47821";

#[derive(Default)]
struct FakeEnv {
    name: String,
    confirm_each: Mutex<bool>,
    terms: Mutex<Vec<PeerTerm>>,
    emits: Mutex<Vec<(String, Value)>>,
    writes: Mutex<Vec<(String, Vec<u8>)>>,
    handoffs: Mutex<Vec<(String, String, String, String)>>,
}

impl FakeEnv {
    fn named(name: &str) -> Arc<FakeEnv> {
        Arc::new(FakeEnv {
            name: name.into(),
            ..FakeEnv::default()
        })
    }

    fn emitted(&self, event: &str) -> Vec<Value> {
        self.emits
            .lock()
            .unwrap()
            .iter()
            .filter(|(e, _)| e == event)
            .map(|(_, v)| v.clone())
            .collect()
    }

    /// Waits for the `n`th (from 1) `event`.
    fn wait(&self, event: &str, n: usize) -> Value {
        let until = Instant::now() + T;
        loop {
            if let Some(v) = self.emitted(event).get(n - 1) {
                return v.clone();
            }
            assert!(Instant::now() < until, "no {event} #{n}");
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn term(&self, id: &str, title: &str) {
        self.terms.lock().unwrap().push(PeerTerm {
            id: id.into(),
            title: title.into(),
            agent: Some("claude".into()),
            state: PeerTermState::Running,
            project_id: Some("p1".into()),
        });
    }
}

impl HostEnv for FakeEnv {
    fn host_name(&self) -> String {
        self.name.clone()
    }

    fn xid(&self) -> Option<String> {
        None
    }

    fn confirm_each(&self) -> bool {
        *self.confirm_each.lock().unwrap()
    }

    fn projects(&self) -> Vec<LocalProject> {
        vec![LocalProject {
            id: "p1".into(),
            name: "app".into(),
            path: "/work/app".into(),
        }]
    }

    fn terms(&self) -> Vec<PeerTerm> {
        self.terms.lock().unwrap().clone()
    }

    fn write(&self, term: &str, data: &[u8]) -> Result<(), RpcError> {
        self.writes
            .lock()
            .unwrap()
            .push((term.into(), data.to_vec()));
        Ok(())
    }

    fn kill(&self, _term: &str) -> Result<(), RpcError> {
        Ok(())
    }

    fn open_tab(
        &self,
        project: &LocalProject,
        profile: &str,
        _prompt: Option<String>,
        title: String,
    ) -> Result<PeerTerm, RpcError> {
        Ok(PeerTerm {
            id: "t-new".into(),
            title,
            agent: Some(profile.into()),
            state: PeerTermState::Running,
            project_id: Some(project.id.clone()),
        })
    }

    fn hand_off(
        &self,
        from_host: &str,
        to_tab: &str,
        from_title: &str,
        body: &str,
    ) -> Result<Value, RpcError> {
        self.handoffs.lock().unwrap().push((
            from_host.into(),
            to_tab.into(),
            from_title.into(),
            body.into(),
        ));
        Ok(json!({ "id": "msg_1", "from": format!("peer:{from_host}"), "to": "tab:t-1" }))
    }

    fn emit(&self, event: &str, payload: Value) {
        self.emits.lock().unwrap().push((event.into(), payload));
    }

    fn changed(&self) {}
}

struct Shared(Arc<MemConnect>);

impl Connect for Shared {
    fn connect(&self, addr: &str) -> Result<Box<dyn xdev_link::wire::Wire>, LinkError> {
        self.0.connect(addr)
    }
}

struct World {
    _dir: tempfile::TempDir,
    h: Arc<Core>,
    h_env: Arc<FakeEnv>,
    h_clock: FakeClock,
    host: Arc<Host>,
    j: Arc<Core>,
    j_env: Arc<FakeEnv>,
    connector: Arc<MemConnect>,
}

impl World {
    fn new(joiner_key: u8) -> World {
        let dir = tempfile::tempdir().unwrap();
        let h_key = Arc::new(HostKey::from_private([10; 32]).unwrap());
        let h_id = h_key.host_id();
        let h_env = FakeEnv::named("this-pc");
        // Starts at the real time the Host checks the pair window with; only
        // the host side's questions read it after that.
        let h_clock = FakeClock::new(xdev_link::Clock::now_ms(&SystemClock));
        let h = Core::new(
            h_env.clone(),
            h_key.clone(),
            Arc::new(PeerStore::open(&dir.path().join("host.json")).unwrap()),
            Arc::new(FakeDiscover::default()),
            Arc::new(h_clock.clone()),
            Box::new(Shared(Arc::new(MemConnect::default()))),
        );
        let (tx, events) = channel();
        let host = Host::new(
            h_key,
            h.store.clone(),
            h.window.clone(),
            h.serve(),
            tx,
            &ListenCfg::default(),
            HostOpts {
                handshake_ms: 5_000,
                confirm_ms: 5_000,
                ..HostOpts::default()
            },
        );
        h.set_host(Some(host.clone()));
        {
            let h = h.clone();
            thread::spawn(move || {
                for ev in events {
                    h.on_event(ev);
                }
            });
        }
        let connector = Arc::new(MemConnect::default());
        let j_env = FakeEnv::named("studio-mac");
        let addr: SocketAddr = ADDR.parse().unwrap();
        let j = Core::new(
            j_env.clone(),
            Arc::new(HostKey::from_private([joiner_key; 32]).unwrap()),
            Arc::new(PeerStore::open(&dir.path().join("joiner.json")).unwrap()),
            Arc::new(FakeDiscover::with_hosts(vec![Nearby {
                host_id: h_id,
                name: Some("this-pc".into()),
                addrs: vec![addr],
                pairing: true,
            }])),
            Arc::new(SystemClock),
            Box::new(Shared(connector.clone())),
        );
        World {
            _dir: dir,
            h,
            h_env,
            h_clock,
            host,
            j,
            j_env,
            connector,
        }
    }

    /// Lets the joiner dial the host once more.
    fn plug(&self) {
        let (a, b) = pipe();
        self.connector.add(ADDR, a);
        let host = self.host.clone();
        thread::spawn(move || serve_conn(Box::new(b), &host));
    }

    fn target(&self) -> JoinTarget {
        JoinTarget::Nearby {
            host_id: self.h.host_id(),
        }
    }

    /// Pairs the joiner; the host gives it `role`. Answers the pair result
    /// the joiner saw.
    fn pair(&self, grant_back: bool, role: PeerRole, accept: bool) -> Value {
        let code = self.h.pair_start(vec![ADDR.into()]).unwrap().code;
        self.plug();
        let pending = self.j.pair_join(&self.target(), &code, grant_back).unwrap();
        let req = self.h_env.wait("peers://pair-request", 1);
        assert_eq!(req["sas"], pending.sas, "both screens show the same SAS");
        assert_eq!(pending.name, "this-pc");
        self.j
            .pair_confirm(&pending.request_id, true, PeerRole::Operator)
            .unwrap();
        self.h
            .pair_confirm(req["requestId"].as_str().unwrap(), accept, role)
            .unwrap();
        self.j_env.wait("peers://pair-result", 1)
    }

    fn paired(joiner_key: u8, role: PeerRole) -> World {
        let w = World::new(joiner_key);
        assert_eq!(w.pair(false, role, true)["ok"], true);
        w.plug();
        w
    }

    fn joiner_id(&self) -> String {
        self.h.store.list()[0].id.clone()
    }

    fn call(&self, m: &str, p: Value) -> Result<Value, RpcError> {
        self.j.call(&self.h.host_id(), m, p, CALL_WAIT)
    }
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn code(r: Result<Value, RpcError>) -> String {
    r.unwrap_err().code
}

#[test]
fn pairing_without_grant_back_leaves_the_host_no_role_here() {
    let w = World::new(30);
    let res = w.pair(false, PeerRole::Viewer, true);
    assert_eq!(res["ok"], true);
    assert_eq!(res["name"], "this-pc");
    let host_here = &w.j.store.list()[0];
    assert_eq!(host_here.role, PeerRole::None);
    let joiner_there = &w.h.store.list()[0];
    assert_eq!(joiner_there.name, "studio-mac");
    assert_eq!(joiner_there.role, PeerRole::Viewer);
    assert!(!w.h.pairing(), "the code is single use");
}

#[test]
fn pairing_with_grant_back_gives_the_host_the_chosen_role() {
    let w = World::new(31);
    let code = w.h.pair_start(vec![ADDR.into()]).unwrap().code;
    w.plug();
    let pending = w.j.pair_join(&w.target(), &code, true).unwrap();
    let req = w.h_env.wait("peers://pair-request", 1);
    w.j.pair_confirm(&pending.request_id, true, PeerRole::Operator)
        .unwrap();
    w.h.pair_confirm(req["requestId"].as_str().unwrap(), true, PeerRole::Viewer)
        .unwrap();
    assert_eq!(w.j_env.wait("peers://pair-result", 1)["ok"], true);
    assert_eq!(w.j.store.list()[0].role, PeerRole::Operator);
}

#[test]
fn a_wrong_code_is_pair_code_and_a_no_is_pair_rejected() {
    let w = World::new(32);
    let right = w.h.pair_start(vec![ADDR.into()]).unwrap().code;
    w.plug();
    let wrong = if right.starts_with('2') {
        "33333-33333"
    } else {
        "22222-22222"
    };
    let e = w.j.pair_join(&w.target(), wrong, false).unwrap_err();
    assert_eq!(e.code, "pair_code");
    let garbage = w.j.pair_join(&w.target(), "nope", false).unwrap_err();
    assert_eq!(garbage.code, "pair_code");

    let w = World::new(33);
    let res = w.pair(false, PeerRole::Viewer, false);
    assert_eq!(res["ok"], false);
    assert_eq!(res["error"], "pair_rejected");
    assert!(w.j.store.list().is_empty());
    assert!(w.h.store.list().is_empty());
}

#[test]
fn the_role_table() {
    let w = World::paired(34, PeerRole::None);
    w.h_env.term("t-roles", "build");
    let write = json!({ "id": "t-roles", "data_b64": b64(b"ls\r") });
    let start = json!({ "project_id": "p1", "profile_id": "claude" });
    let shell = json!({ "project_id": "p1" });
    let kill = json!({ "id": "t-roles" });
    let handoff = json!({ "to_tab": "t-roles", "from_title": "Lead", "body": "hi" });

    // hello and bye need no role.
    assert_eq!(w.call("hello", json!({})).unwrap()["yourRole"], "none");
    assert_eq!(code(w.call("terms.list", json!({}))), "peer_role");
    assert_eq!(code(w.call("projects.list", json!({}))), "peer_role");

    let id = w.joiner_id();
    w.h.set_role(&id, PeerRole::Viewer).unwrap();
    assert!(w.call("terms.list", json!({})).is_ok());
    assert!(w.call("projects.list", json!({})).is_ok());
    assert_eq!(code(w.call("term.write", write.clone())), "peer_role");
    assert_eq!(code(w.call("agent.start", start.clone())), "peer_role");
    assert_eq!(code(w.call("mail.handoff", handoff.clone())), "peer_role");

    w.h.set_role(&id, PeerRole::Operator).unwrap();
    assert!(w.call("term.write", write).is_ok());
    let term = w.call("agent.start", start).unwrap();
    assert_eq!(term["title"], "claude (from studio-mac)");
    assert!(w.call("mail.handoff", handoff).is_ok());
    assert_eq!(code(w.call("shell.open", shell.clone())), "peer_role");
    assert_eq!(code(w.call("term.kill", kill.clone())), "peer_role");

    w.h.set_role(&id, PeerRole::Admin).unwrap();
    assert_eq!(
        w.call("shell.open", shell).unwrap()["title"],
        "shell (from studio-mac)"
    );
    assert!(w.call("term.kill", kill).is_ok());
    assert_eq!(code(w.call("files.read", json!({}))), "unsupported");
    let acts = w.h_env.emitted("peers://activity");
    let actions: Vec<_> = acts.iter().map(|a| a["action"].clone()).collect();
    assert_eq!(
        actions,
        ["typed", "started", "handed_off", "started", "killed"]
    );
}

#[test]
fn projects_list_shows_the_path_to_admin_only() {
    let w = World::paired(35, PeerRole::Operator);
    let list = w.call("projects.list", json!({})).unwrap();
    assert_eq!(list[0]["name"], "app");
    assert_eq!(list[0]["path"], Value::Null);
    w.h.set_role(&w.joiner_id(), PeerRole::Admin).unwrap();
    let list = w.call("projects.list", json!({})).unwrap();
    assert_eq!(list[0]["path"], "/work/app");
}

#[test]
fn a_write_over_4096_bytes_is_refused() {
    let w = World::paired(36, PeerRole::Operator);
    w.h_env.term("t-big", "build");
    let big = json!({ "id": "t-big", "data_b64": b64(&[b'a'; 4097]) });
    assert_eq!(code(w.call("term.write", big)), "bad_request");
    let ok = json!({ "id": "t-big", "data_b64": b64(&[b'a'; 4096]) });
    assert!(w.call("term.write", ok).is_ok());
    let writes = w.h_env.writes.lock().unwrap();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].1.len(), 4096);
}

/// Starts `agent.start` on another thread and waits for the question here.
fn ask(w: &World) -> (thread::JoinHandle<Result<Value, RpcError>>, String, usize) {
    let n = w.h_env.emitted("peers://confirm").len() + 1;
    let j = w.j.clone();
    let host = w.h.host_id();
    let call = thread::spawn(move || {
        j.call(
            &host,
            "agent.start",
            json!({ "project_id": "p1", "profile_id": "claude" }),
            ACTION_WAIT,
        )
    });
    let q = w.h_env.wait("peers://confirm", n);
    assert_eq!(q["action"], "start");
    assert_eq!(q["peer"], "studio-mac");
    (call, q["requestId"].as_str().unwrap().to_owned(), n)
}

#[test]
fn confirm_each_allows_denies_and_times_out() {
    let w = World::paired(37, PeerRole::Operator);
    *w.h_env.confirm_each.lock().unwrap() = true;

    let (call, id, _) = ask(&w);
    assert!(host::reply(&w.h, &id, true));
    assert!(call.join().unwrap().is_ok());

    let (call, id, _) = ask(&w);
    assert!(host::reply(&w.h, &id, false));
    assert_eq!(call.join().unwrap().unwrap_err().code, "peer_denied");

    let (call, id, _) = ask(&w);
    w.h_clock.advance(host::CONFIRM_MS + 1);
    assert_eq!(call.join().unwrap().unwrap_err().code, "peer_denied");
    assert!(!host::reply(&w.h, &id, true), "a late click is ignored");
    let started = w.h_env.emitted("peers://activity").len();
    assert_eq!(started, 1, "only the allowed start ran");
}

#[test]
fn a_watch_streams_and_resumes_from_its_seq_after_a_drop() {
    let w = World::paired(38, PeerRole::Viewer);
    tap::open_for_test("t-watch");
    tap::feed("t-watch", b"hello");
    let got: Arc<Mutex<Vec<u8>>> = Arc::default();
    let sink = got.clone();
    let host = w.h.host_id();
    let size =
        w.j.attach(
            &host,
            "t-watch",
            Box::new(move |b| sink.lock().unwrap().extend_from_slice(b)),
        )
        .unwrap();
    assert_eq!((size.cols, size.rows), (80, 24));
    let until = |want: &[u8]| {
        let t = Instant::now() + T;
        while got.lock().unwrap().as_slice() != want {
            assert!(
                Instant::now() < t,
                "got {:?}",
                String::from_utf8_lossy(&got.lock().unwrap())
            );
            thread::sleep(Duration::from_millis(10));
        }
    };
    until(b"hello");
    tap::feed("t-watch", b" world");
    until(b"hello world");

    // The link drops; output goes on; the watch comes back from seq 11.
    w.plug();
    w.j.open_link(&host).unwrap().close();
    let closed = w.j_env.wait("peers://term-closed", 1);
    assert_eq!(closed["reason"], "offline");
    assert_eq!(closed["termId"], "t-watch");
    tap::feed("t-watch", b" again");
    until(b"hello world again");
    tap::feed("t-watch", b"!");
    until(b"hello world again!");

    // The tab exits: the watch ends with `exited`.
    tap::close_for_test("t-watch");
    let closed = w.j_env.wait("peers://term-closed", 2);
    assert_eq!(closed["reason"], "exited");
    assert!(w.j.attach(&host, "t-watch", Box::new(|_| {})).is_err());
}

#[test]
fn a_hand_off_routes_by_computer_name() {
    let w = World::paired(39, PeerRole::Operator);
    let resolve = |n: &str| w.j.resolve(n);
    assert_eq!(
        mail::route("this-pc/review", resolve),
        Route::Peer {
            peer_id: w.h.host_id(),
            tab: "review".into()
        }
    );
    assert_eq!(
        mail::route("THIS-PC/review", resolve),
        mail::route("this-pc/review", resolve)
    );
    assert_eq!(mail::route("review", resolve), Route::Local);
    assert_eq!(mail::route("A-laptop/review", resolve), Route::Local);
    assert_eq!(mail::route("this-pc/", resolve), Route::Local);

    let v = mail::send(&w.j, &w.h.host_id(), "review", "Lead", "please look").unwrap();
    assert_eq!(v["to"], format!("peer:{}/review", w.h.host_id()));
    let got = w.h_env.handoffs.lock().unwrap().clone();
    assert_eq!(
        got,
        vec![(
            w.j.host_id(),
            "review".to_owned(),
            "Lead".to_owned(),
            "please look".to_owned()
        )]
    );
}

#[test]
fn the_peers_report_lists_tabs_only_with_a_viewer_role() {
    let w = World::paired(40, PeerRole::None);
    w.h_env.term("t-rep", "review");
    w.call("hello", json!({})).unwrap();
    let r = w.j.report();
    assert_eq!(r.len(), 1);
    assert_eq!(r[0]["name"], "this-pc");
    assert_eq!(r[0]["online"], true);
    assert_eq!(r[0]["theirRole"], "none");
    assert!(r[0].get("tabs").is_none());

    w.h.set_role(&w.joiner_id(), PeerRole::Viewer).unwrap();
    w.j.open_link(&w.h.host_id()).unwrap().close();
    let t = Instant::now() + T;
    while w.j.is_online(&w.h.host_id()) {
        assert!(Instant::now() < t);
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(w.j.report()[0]["online"], false);
    w.plug();
    w.call("hello", json!({})).unwrap();
    let r = w.j.report();
    assert_eq!(r[0]["theirRole"], "viewer");
    assert_eq!(
        r[0]["tabs"],
        json!([{ "id": "t-rep", "title": "review", "state": "running" }])
    );
}

#[test]
fn removing_a_peer_drops_its_link_at_once() {
    let w = World::paired(41, PeerRole::Viewer);
    w.call("hello", json!({})).unwrap();
    let id = w.joiner_id();
    assert!(w.h.is_online(&id));
    w.h.remove(&id).unwrap();
    assert!(!w.h.is_online(&id));
    assert!(w.h.store.list().is_empty());
    let host = w.h.host_id();
    let t = Instant::now() + T;
    while w.j.is_online(&host) {
        assert!(Instant::now() < t);
        thread::sleep(Duration::from_millis(10));
    }
}
