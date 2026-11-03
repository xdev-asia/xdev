use std::fs;
use std::path::{Path, PathBuf};

use xdev_kit::HomeSource;
use xdev_workspace::{RepoEntry, WorktreeMeta};

use super::*;

/// A registry of one repo (`<root>/repo`) and two worktrees
/// (`<root>/repo-oak`, `<root>/repo-elm`), each folder made on the disk.
fn registry(root: &Path) -> Registry {
    for name in ["repo", "repo-oak", "repo-elm"] {
        fs::create_dir_all(root.join(name).join("src")).unwrap();
    }
    let wt = |name: &str| WorktreeMeta {
        repo_id: "r1".into(),
        path: root.join(name),
        start: "0".repeat(40),
        pinned: false,
        created_ms: 0,
        made_here: true,
    };
    Registry {
        repos: vec![RepoEntry {
            id: "r1".into(),
            short_name: "repo".into(),
            path: root.join("repo"),
            base_ref: "main".into(),
            worktree_root: root.to_path_buf(),
        }],
        worktrees: vec![wt("repo-oak"), wt("repo-elm")],
        ..Registry::default()
    }
}

fn session(id: &str, agent: Agent, cwd: &Path, title: &str, first: i64, last: i64) -> AgentSession {
    let home_id = match agent {
        Agent::Claude => "own-claude",
        Agent::Codex => "own-codex",
    };
    AgentSession {
        key: format!("{home_id}:{id}"),
        id: id.into(),
        home_id: home_id.into(),
        agent,
        cwd: Some(cwd.to_string_lossy().into_owned()),
        branch: Some(format!("feat/{id}")),
        title: Some(title.into()),
        model: Some("model-a".into()),
        first,
        last,
        messages: 2,
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    folders: Folders,
    all: Vec<AgentSession>,
}

/// Sessions in the repo, in each worktree (one in a subfolder) and one
/// outside every registry folder.
fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let folders = Folders::of(&registry(&root));
    fs::create_dir_all(root.join("elsewhere")).unwrap();
    let all = vec![
        session(
            "a1",
            Agent::Claude,
            &root.join("repo"),
            "Fix the parser",
            10,
            60,
        ),
        session(
            "b2",
            Agent::Codex,
            &root.join("repo-oak").join("src"),
            "Add a sessions panel",
            20,
            50,
        ),
        session(
            "c3",
            Agent::Claude,
            &root.join("repo-elm"),
            "Parser tests on Windows",
            30,
            40,
        ),
        session(
            "d4",
            Agent::Claude,
            &root.join("elsewhere"),
            "Unrelated work",
            40,
            30,
        ),
    ];
    Fixture {
        _dir: dir,
        root,
        folders,
        all,
    }
}

fn query(scope: SessionScope) -> SessionQuery {
    SessionQuery {
        text: None,
        scope,
        agent: None,
        home_id: None,
        sort: SessionSort::LastDesc,
        limit: 100,
    }
}

fn path_of(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

impl Fixture {
    fn ids(&self, q: &SessionQuery) -> Vec<String> {
        self.rows(q).into_iter().map(|r| r.session.id).collect()
    }

    fn rows(&self, q: &SessionQuery) -> Vec<SessionRow> {
        let refs: Vec<&AgentSession> = self.all.iter().collect();
        select(&refs, &self.folders, q, &|p| Path::new(p).is_dir())
    }
}

#[test]
fn each_session_is_matched_to_its_worktree_and_repo() {
    let f = fixture();
    let rows = f.rows(&query(SessionScope::All));
    let by_id = |id: &str| rows.iter().find(|r| r.session.id == id).unwrap();
    let repo = path_of(&f.root.join("repo"));
    assert_eq!(by_id("a1").worktree.as_deref(), Some(repo.as_str()));
    assert_eq!(by_id("a1").repo.as_deref(), Some(repo.as_str()));
    assert_eq!(
        by_id("b2").worktree.as_deref(),
        Some(path_of(&f.root.join("repo-oak")).as_str())
    );
    assert_eq!(by_id("b2").repo.as_deref(), Some(repo.as_str()));
    assert_eq!(by_id("d4").worktree, None);
    assert_eq!(by_id("d4").repo, None);
}

#[test]
fn the_scope_picks_a_worktree_a_repo_or_everything() {
    let f = fixture();
    let oak = path_of(&f.root.join("repo-oak"));
    assert_eq!(f.ids(&query(SessionScope::Worktree { path: oak })), ["b2"]);
    let repo = path_of(&f.root.join("repo"));
    assert_eq!(
        f.ids(&query(SessionScope::Worktree { path: repo.clone() })),
        ["a1"]
    );
    assert_eq!(
        f.ids(&query(SessionScope::Repo { path: repo })),
        ["a1", "b2", "c3"]
    );
    assert_eq!(f.ids(&query(SessionScope::All)), ["a1", "b2", "c3", "d4"]);
}

#[test]
fn a_scope_path_matches_in_another_spelling() {
    let f = fixture();
    let oak = path_of(&f.root.join("repo-oak")).replace('\\', "/") + "/";
    let oak = if cfg!(windows) {
        oak.to_uppercase()
    } else {
        oak
    };
    assert_eq!(f.ids(&query(SessionScope::Worktree { path: oak })), ["b2"]);
}

#[test]
fn every_word_of_the_text_must_match_a_field_or_start_the_id() {
    let mut f = fixture();
    let mut q = query(SessionScope::All);
    q.text = Some("elsewhere".into());
    assert_eq!(f.ids(&q), ["d4"]);
    // The temp folder's random name is in every cwd and could hold any
    // letter or digit; the other words are checked without folders.
    for s in &mut f.all {
        s.cwd = None;
    }
    q.text = Some("PARSER windows".into());
    assert_eq!(f.ids(&q), ["c3"]);
    q.text = Some("parser".into());
    assert_eq!(f.ids(&q), ["a1", "c3"]);
    q.text = Some("feat/b2".into());
    assert_eq!(f.ids(&q), ["b2"]);
    q.text = Some("b".into());
    assert_eq!(f.ids(&q), ["b2"]);
    q.text = Some("2".into());
    // In a branch (`feat/b2`), not at the start of an id.
    assert_eq!(f.ids(&q), ["b2"]);
    q.text = Some("   ".into());
    assert_eq!(f.ids(&q).len(), 4);
}

#[test]
fn the_agent_and_home_filters() {
    let f = fixture();
    let mut q = query(SessionScope::All);
    q.agent = Some(Agent::Codex);
    assert_eq!(f.ids(&q), ["b2"]);
    q.agent = None;
    q.home_id = Some("own-claude".into());
    assert_eq!(f.ids(&q), ["a1", "c3", "d4"]);
}

#[test]
fn sort_by_last_or_first_and_cut_to_the_limit() {
    let f = fixture();
    let mut q = query(SessionScope::All);
    q.sort = SessionSort::FirstDesc;
    assert_eq!(f.ids(&q), ["d4", "c3", "b2", "a1"]);
    q.limit = 2;
    assert_eq!(f.ids(&q), ["d4", "c3"]);
    q.sort = SessionSort::LastDesc;
    assert_eq!(f.ids(&q), ["a1", "b2"]);
}

#[test]
fn a_gone_folder_or_an_env_home_is_not_resumable() {
    let mut f = fixture();
    fs::remove_dir_all(f.root.join("elsewhere")).unwrap();
    f.all[2].home_id = "env-claude".into();
    f.all[1].home_id = "acct-work".into();
    let rows = f.rows(&query(SessionScope::All));
    let resumable: Vec<(String, bool)> = rows
        .into_iter()
        .map(|r| (r.session.id, r.resumable))
        .collect();
    assert_eq!(
        resumable,
        [
            ("a1".to_string(), true),
            ("b2".to_string(), true),
            ("c3".to_string(), false),
            ("d4".to_string(), false),
        ]
    );
}

#[test]
fn a_session_without_a_folder_is_only_in_all_and_not_resumable() {
    let mut f = fixture();
    f.all[0].cwd = None;
    let repo = path_of(&f.root.join("repo"));
    assert_eq!(
        f.ids(&query(SessionScope::Repo { path: repo })),
        ["b2", "c3"]
    );
    let rows = f.rows(&query(SessionScope::All));
    assert!(!rows[0].resumable);
}

fn claude_home(user: &Path) -> Home {
    Home {
        id: "own-claude".into(),
        agent: Agent::Claude,
        path: user.join(".claude"),
        source: HomeSource::Own,
    }
}

#[test]
fn a_refresh_reads_the_logs_and_saves_the_index() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let data = root.join("data");
    fs::create_dir_all(&data).unwrap();
    let logs = root
        .join("user")
        .join(".claude")
        .join("projects")
        .join("-w");
    fs::create_dir_all(&logs).unwrap();
    let cwd = root.join("w");
    fs::create_dir_all(&cwd).unwrap();
    let ts = "2030-01-01T00:00:00Z";
    let line = format!(
        r#"{{"type":"user","cwd":{},"timestamp":"{ts}","message":{{"content":"hello there"}}}}"#,
        serde_json::to_string(&path_of(&cwd)).unwrap()
    );
    fs::write(logs.join("s1.jsonl"), line + "\n").unwrap();
    let homes = || vec![claude_home(&root.join("user"))];
    let q = query(SessionScope::All);

    let rows = sessions(&data, homes, &q, None).unwrap();
    assert!(rows.is_empty(), "no refresh, no saved index");

    let rows = sessions(&data, homes, &q, Some(0)).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].session.title.as_deref(), Some("hello there"));
    assert!(rows[0].resumable);
    assert!(data.join("kit").join("sessions.json").is_file());

    // Kept between calls without a refresh.
    assert_eq!(sessions(&data, homes, &q, None).unwrap().len(), 1);
}

/// 2030-01-01T00:00:00Z in unix ms.
const JAN_2030: i64 = 1_893_456_000_000;
const DAY: i64 = 24 * 60 * 60 * 1000;

#[test]
fn the_history_window_is_a_cutoff_in_days_within_its_range() {
    assert_eq!(history_cutoff(JAN_2030, 90), JAN_2030 - 90 * DAY);
    assert_eq!(history_cutoff(JAN_2030, 0), JAN_2030 - DAY);
    assert_eq!(history_cutoff(JAN_2030, 10_000), JAN_2030 - 3650 * DAY);
    assert_eq!(HISTORY_DAYS, 90);
}

#[test]
fn a_narrower_window_prunes_on_the_next_refresh() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let data = root.join("data");
    let logs = root
        .join("user")
        .join(".claude")
        .join("projects")
        .join("-w");
    fs::create_dir_all(&logs).unwrap();
    let line = |id: &str, ts: &str| {
        format!(
            r#"{{"type":"user","sessionId":"{id}","timestamp":"{ts}","message":{{"content":"hi {id}"}}}}"#
        ) + "
"
    };
    // Ten days and one day before the "now" below.
    fs::write(logs.join("old.jsonl"), line("old", "2030-01-01T00:00:00Z")).unwrap();
    fs::write(logs.join("new.jsonl"), line("new", "2030-01-10T00:00:00Z")).unwrap();
    let homes = || vec![claude_home(&root.join("user"))];
    let q = query(SessionScope::All);
    let now = JAN_2030 + 10 * DAY;
    let ids = |rows: Vec<SessionRow>| rows.into_iter().map(|r| r.session.id).collect::<Vec<_>>();

    let rows = sessions(&data, homes, &q, Some(history_cutoff(now, 90))).unwrap();
    assert_eq!(ids(rows), ["new", "old"]);

    let rows = sessions(&data, homes, &q, Some(history_cutoff(now, 5))).unwrap();
    assert_eq!(ids(rows), ["new"]);
    // The pruned index is the one saved.
    assert_eq!(SessionIndex::load(&data).list().len(), 1);
}
