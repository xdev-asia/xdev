use std::path::PathBuf;

use super::*;

fn proc(pid: u32, ppid: u32, name: &str, cmd: &str) -> Proc {
    Proc {
        pid,
        ppid: Some(ppid),
        name: name.into(),
        cmd: cmd.into(),
        cwd: Some(PathBuf::from("/work/app")),
        start: Some(1_000 + u64::from(pid)),
    }
}

/// launchd, a terminal app with a login shell, and the `own` xDev app.
fn machine() -> Vec<Proc> {
    vec![
        proc(1, 0, "launchd", "/sbin/launchd"),
        proc(
            10,
            1,
            "Terminal",
            "/System/Applications/Utilities/Terminal.app",
        ),
        proc(11, 10, "login", "login -pf me"),
        proc(12, 11, "-zsh", "-zsh"),
        proc(20, 1, "xdev", "/Applications/xDev.app/Contents/MacOS/xdev"),
        proc(21, 20, "zsh", "/bin/zsh -l"),
        proc(22, 21, "claude", "claude"),
    ]
}

fn far() -> Limits {
    Limits {
        rows: ROWS_MAX,
        deadline: Instant::now() + Duration::from_secs(60),
    }
}

fn run(procs: &[Proc], own: &[u32], sessions: &[&AgentSession]) -> ForeignScan {
    scan(procs, own, sessions, &|_| true, far(), &mut Instant::now)
}

fn pids(scan: &ForeignScan) -> Vec<u32> {
    scan.rows.iter().map(|r| r.pid).collect()
}

fn session(id: &str, agent: Agent, cwd: &str, last: i64) -> AgentSession {
    AgentSession {
        key: format!("own-claude:{id}"),
        id: id.into(),
        home_id: "own-claude".into(),
        agent,
        cwd: Some(cwd.into()),
        branch: None,
        title: None,
        model: None,
        first: 0,
        last,
        messages: 2,
    }
}

#[test]
fn leaves_out_xdev_and_everything_under_it() {
    let got = run(&machine(), &[20], &[]);
    assert_eq!(pids(&got), vec![12]);
    assert!(!got.truncated);
}

#[test]
fn leaves_out_the_terminal_service_and_terminal_roots() {
    let mut procs = machine();
    procs.push(proc(30, 1, "xdev-ptyd", "xdev-ptyd"));
    procs.push(proc(31, 30, "bash", "bash"));
    procs.push(proc(32, 31, "codex", "codex"));
    procs.push(proc(40, 10, "zsh", "zsh"));
    procs.push(proc(41, 40, "codex", "codex"));
    let got = run(&procs, &[20, 30, 40], &[]);
    assert_eq!(pids(&got), vec![12]);
}

#[test]
fn a_reused_parent_pid_does_not_count_as_xdev() {
    let mut procs = machine();
    // Started before xDev did, so pid 20 is not its parent.
    let mut early = proc(50, 20, "claude", "claude");
    early.start = Some(5);
    procs.push(early);
    let got = run(&procs, &[20], &[]);
    assert!(pids(&got).contains(&50));
}

#[test]
fn names_the_parent_app_by_its_bundle_or_the_top_of_its_chain() {
    let mut procs = machine();
    procs.push(proc(
        70,
        1,
        "Electron",
        "/Applications/Some Editor.app/Contents/MacOS/Electron",
    ));
    procs.push(proc(
        71,
        70,
        "Editor Helper (Plugin)",
        "/Applications/Some Editor.app/Contents/Frameworks/Editor Helper (Plugin).app/Contents/MacOS/Editor Helper (Plugin) --type=utility",
    ));
    procs.push(proc(72, 71, "bash", "/bin/bash"));
    procs.push(proc(80, 1, "TermHost.exe", "TermHost.exe"));
    procs.push(proc(81, 80, "ConsoleHost.exe", "ConsoleHost.exe"));
    procs.push(proc(82, 81, "pwsh.exe", "pwsh.exe -NoLogo"));
    procs.push(proc(90, 1, "muxer", "muxer -D"));
    procs.push(proc(91, 90, "-fish", "-fish"));
    let got = run(&procs, &[20], &[]);
    let app = |pid: u32| {
        got.rows
            .iter()
            .find(|r| r.pid == pid)
            .and_then(|r| r.parent_app.clone())
    };
    assert_eq!(app(12).as_deref(), Some("Terminal"));
    assert_eq!(app(72).as_deref(), Some("Some Editor"));
    assert_eq!(app(82).as_deref(), Some("TermHost"));
    assert_eq!(app(91).as_deref(), Some("muxer"));
    let row = got.rows.iter().find(|r| r.pid == 82).unwrap();
    assert_eq!(row.name, "pwsh");
    assert_eq!(got.rows.iter().find(|r| r.pid == 91).unwrap().name, "fish");
}

#[test]
fn a_shell_with_no_app_above_it_or_a_handed_command_is_not_a_session() {
    let procs = vec![
        proc(1, 0, "launchd", "launchd"),
        proc(4, 1, "zsh", "zsh"),
        proc(5, 1, "cron", "cron"),
        proc(6, 5, "sh", "sh -c backup"),
        proc(7, 6, "codex", "codex"),
    ];
    let got = run(&procs, &[], &[]);
    // The agent is listed anyway, named by the top of its chain.
    assert_eq!(pids(&got), vec![7]);
    assert_eq!(got.rows[0].parent_app.as_deref(), Some("cron"));
}

#[test]
fn shells_an_agent_or_a_shell_started_are_not_sessions() {
    let mut procs = machine();
    procs.push(proc(90, 12, "claude", "claude"));
    procs.push(proc(91, 90, "bash", "/bin/bash -c ls"));
    procs.push(proc(92, 12, "bash", "bash"));
    procs.push(proc(93, 12, "node", "node build.js"));
    procs.push(proc(94, 93, "sh", "sh -c make"));
    let got = run(&procs, &[20], &[]);
    assert_eq!(pids(&got), vec![90, 12]);
}

#[test]
fn finds_agents_by_name_and_by_script() {
    let mut procs = machine();
    procs.push(proc(100, 12, "codex", "codex --model x"));
    procs.push(proc(101, 12, "node", "node /usr/local/bin/gemini"));
    procs.push(proc(102, 12, "kimi-code", "kimi-code"));
    procs.push(proc(103, 12, "python3", "python3 -m http.server"));
    procs.push(proc(104, 12, "aider.exe", "aider.exe"));
    let got = run(&procs, &[20], &[]);
    let agent = |pid: u32| {
        got.rows
            .iter()
            .find(|r| r.pid == pid)
            .and_then(|r| r.agent.clone())
    };
    assert_eq!(agent(100).as_deref(), Some("codex"));
    assert_eq!(agent(101).as_deref(), Some("gemini"));
    assert_eq!(agent(102).as_deref(), Some("kimi"));
    assert_eq!(agent(104).as_deref(), Some("aider"));
    assert!(!pids(&got).contains(&103));
    assert_eq!(agent(12), None);
    let codex = got.rows.iter().find(|r| r.pid == 100).unwrap();
    assert_eq!(codex.agent_title.as_deref(), Some("Codex"));
}

#[test]
fn every_built_in_binary_counts_as_an_agent() {
    for cli in Cli::ALL {
        for name in xdev_agent::spec(cli).commands {
            assert_eq!(agent_of(&proc(2, 1, name, name)), Some(cli), "{name}");
        }
    }
}

#[test]
fn a_helper_of_the_same_agent_is_not_a_second_row() {
    let mut procs = machine();
    procs.push(proc(110, 12, "claude", "claude"));
    procs.push(proc(111, 110, "claude", "claude --mcp"));
    procs.push(proc(112, 110, "codex", "codex exec"));
    let got = run(&procs, &[20], &[]);
    assert_eq!(pids(&got), vec![112, 110, 12]);
}

#[test]
fn agents_come_first_then_the_newest() {
    let mut procs = machine();
    procs.push(proc(120, 10, "zsh", "zsh"));
    procs.push(proc(121, 12, "codex", "codex"));
    procs.push(proc(122, 120, "claude", "claude"));
    let got = run(&procs, &[20], &[]);
    assert_eq!(pids(&got), vec![122, 121, 120, 12]);
}

#[test]
fn reads_the_session_id_on_the_command_line() {
    assert_eq!(session_arg("claude --resume abc"), Some("abc"));
    assert_eq!(session_arg("claude -r abc"), Some("abc"));
    assert_eq!(session_arg("claude --resume=abc"), Some("abc"));
    assert_eq!(session_arg("claude --session-id abc"), Some("abc"));
    assert_eq!(session_arg("codex resume abc"), Some("abc"));
    assert_eq!(session_arg("claude --resume --model x"), None);
    assert_eq!(session_arg("claude"), None);
}

#[test]
fn matches_a_session_by_id_then_by_folder() {
    let by_id = session("abc", Agent::Claude, "/elsewhere", 1);
    let near = session("near", Agent::Claude, "/work/app", 2_000_000);
    let old = session("old", Agent::Claude, "/work/app", 10);
    let other = session("cx", Agent::Codex, "/work/app", 3_000_000);
    let all = [&by_id, &near, &old, &other];
    let mut procs = machine();
    procs.push(proc(130, 12, "claude", "claude --resume abc"));
    procs.push(proc(131, 12, "claude", "claude"));
    procs.push(proc(132, 12, "gemini", "gemini"));
    let got = run(&procs, &[20], &all);
    let id = |pid: u32| {
        got.rows
            .iter()
            .find(|r| r.pid == pid)
            .and_then(|r| r.session.as_ref().map(|s| s.id.clone()))
    };
    assert_eq!(id(130).as_deref(), Some("abc"));
    assert_eq!(id(131).as_deref(), Some("near"));
    // No index for this agent.
    assert_eq!(id(132), None);
}

#[test]
fn no_session_for_a_folder_idle_since_before_the_start() {
    let old = session("old", Agent::Claude, "/work/app", 10);
    let mut procs = machine();
    procs.push(proc(140, 12, "claude", "claude"));
    let got = run(&procs, &[20], &[&old]);
    assert_eq!(got.rows[0].session, None);
}

#[test]
fn fills_cwd_and_start() {
    let mut procs = machine();
    procs[3].cwd = None;
    let got = scan(&procs, &[20], &[], &|_| false, far(), &mut Instant::now);
    let row = &got.rows[0];
    assert_eq!(row.cwd, None);
    assert!(!row.cwd_is_dir);
    assert_eq!(row.start_ms, Some(1_012_000));
    let mut procs = machine();
    procs.push(proc(150, 12, "codex", "codex"));
    let got = run(&procs, &[20], &[]);
    assert_eq!(got.rows[0].cwd.as_deref(), Some("/work/app"));
    assert!(got.rows[0].cwd_is_dir);
}

#[test]
fn stops_at_the_row_limit() {
    let mut procs = vec![
        proc(1, 0, "launchd", "launchd"),
        proc(2, 1, "Terminal", "Terminal"),
    ];
    for pid in 3..(3 + ROWS_MAX as u32 + 20) {
        procs.push(proc(pid, 2, "zsh", "zsh"));
    }
    let got = run(&procs, &[], &[]);
    assert_eq!(got.rows.len(), ROWS_MAX);
    assert!(got.truncated);
}

#[test]
fn stops_at_the_deadline() {
    let mut procs = vec![
        proc(1, 0, "launchd", "launchd"),
        proc(2, 1, "Terminal", "Terminal"),
    ];
    for pid in 3..1_000 {
        procs.push(proc(pid, 2, "zsh", "zsh"));
    }
    let start = Instant::now();
    let limits = Limits {
        rows: ROWS_MAX,
        deadline: start + BUDGET,
    };
    // Each read of the clock moves it on by one second.
    let mut ticks = 0u32;
    let mut clock = || {
        ticks += 1;
        start + Duration::from_secs(u64::from(ticks))
    };
    let got = scan(&procs, &[], &[], &|_| true, limits, &mut clock);
    assert!(got.truncated);
    assert!(got.rows.len() < CLOCK_EVERY);
}

#[test]
fn a_parent_loop_ends() {
    let mut a = proc(5, 6, "zsh", "zsh");
    let mut b = proc(6, 5, "zsh", "zsh");
    a.start = Some(1);
    b.start = Some(1);
    let got = run(&[a, b], &[], &[]);
    assert!(got.rows.is_empty());
}
