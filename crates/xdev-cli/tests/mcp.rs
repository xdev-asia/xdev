use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use serde_json::{Value, json};
use tempfile::TempDir;

/// Sends the lines on stdin, closes it, and returns one reply per line of
/// stdout, which must hold nothing but JSON-RPC.
fn mcp(cwd: &Path, data_dir: &Path, args: &[&str], lines: &[Value]) -> Vec<Value> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_xdev"))
        .current_dir(cwd)
        .env("XDEV_DATA_DIR", data_dir)
        .arg("mcp")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("run xdev mcp");
    let mut stdin = child.stdin.take().unwrap();
    for line in lines {
        writeln!(stdin, "{line}").unwrap();
    }
    drop(stdin);
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "{out:?}");
    String::from_utf8(out.stdout)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).expect("stdout line is JSON"))
        .collect()
}

fn initialize() -> Value {
    json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{
        "protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1"}}})
}

fn call(id: u64, name: &str, args: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":name,"arguments":args}})
}

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .expect("run git");
    assert!(out.status.success(), "git {args:?}: {out:?}");
}

/// A repo with the vault in `docs/` and one commit.
fn repo() -> TempDir {
    let dir = TempDir::new().unwrap();
    let root = dir.path();
    fs::create_dir(root.join("docs")).unwrap();
    fs::write(
        root.join("docs/auth.md"),
        "# Auth\n\nTokens rotate daily.\n",
    )
    .unwrap();
    fs::write(root.join("docs/guide.md"), "# Guide\n\nSee [[auth]].\n").unwrap();
    fs::write(root.join("docs/notes.txt"), "not a doc").unwrap();
    git(root, &["init", "-q"]);
    for (key, value) in [
        ("user.name", "Test User"),
        ("user.email", "test@example.com"),
        ("commit.gpgsign", "false"),
        ("core.autocrlf", "false"),
    ] {
        git(root, &["config", key, value]);
    }
    git(root, &["add", "-A"]);
    git(root, &["commit", "-q", "-m", "init"]);
    dir
}

#[test]
fn mcp_initialize_and_search() {
    let (repo, data) = (repo(), TempDir::new().unwrap());
    let vault = repo.path().join("docs");
    let replies = mcp(
        repo.path(),
        data.path(),
        &[vault.to_str().unwrap()],
        &[
            initialize(),
            call(1, "search_docs", json!({"query":"tokens"})),
        ],
    );
    assert_eq!(replies.len(), 2, "{replies:?}");
    assert_eq!(replies[0]["result"]["serverInfo"]["name"], "xdev");
    let hits = &replies[1]["result"]["structuredContent"]["hits"];
    assert_eq!(hits[0]["path"], "auth.md", "{replies:?}");
    assert_eq!(hits[0]["title"], "Auth");
}

#[test]
fn get_doc_rejects_bad_paths() {
    let (repo, data) = (repo(), TempDir::new().unwrap());
    let vault = repo.path().join("docs");
    let bad = [
        "../x.md",
        "C:/x.md",
        "/etc/passwd",
        ".git/config",
        "notes.txt",
    ];
    let mut lines = vec![initialize()];
    for (i, path) in bad.iter().enumerate() {
        lines.push(call(i as u64 + 1, "get_doc", json!({"path": path})));
    }
    lines.push(call(99, "get_doc", json!({"path":"auth.md"})));
    let replies = mcp(repo.path(), data.path(), &[vault.to_str().unwrap()], &lines);
    for (reply, path) in replies[1..=bad.len()].iter().zip(bad) {
        assert_eq!(reply["result"]["isError"], true, "{path}: {reply}");
        assert!(reply["result"].get("structuredContent").is_none(), "{path}");
    }
    let doc = &replies[bad.len() + 1]["result"]["structuredContent"];
    assert_eq!(doc["content"], "# Auth\n\nTokens rotate daily.\n", "{doc}");
    assert_eq!(doc["backlinks"], json!(["guide.md"]));
}

#[test]
fn propose_then_changes_shows_ai() {
    let (repo, data) = (repo(), TempDir::new().unwrap());
    let vault = repo.path().join("docs");
    let dir = vault.to_str().unwrap();
    let replies = mcp(
        repo.path(),
        data.path(),
        &[dir],
        &[
            initialize(),
            call(
                1,
                "propose_update",
                json!({"path":"auth.md","content":"# Auth\n\nTokens rotate hourly.\n","summary":"rotation changed"}),
            ),
        ],
    );
    assert!(replies[1]["result"]["isError"] != true, "{replies:?}");
    assert_eq!(
        fs::read_to_string(vault.join("auth.md")).unwrap(),
        "# Auth\n\nTokens rotate hourly.\n"
    );
    let out = Command::new(env!("CARGO_BIN_EXE_xdev"))
        .env("XDEV_DATA_DIR", data.path())
        .args(["changes", dir])
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8(out.stdout).unwrap(),
        "modified\tauth.md\n"
    );
}

#[test]
fn propose_without_git_writes_nothing() {
    let (vault, data) = (TempDir::new().unwrap(), TempDir::new().unwrap());
    fs::write(vault.path().join("a.md"), "# A\n").unwrap();
    let replies = mcp(
        vault.path(),
        data.path(),
        &[],
        &[
            initialize(),
            call(
                1,
                "propose_update",
                json!({"path":"a.md","content":"# B\n"}),
            ),
        ],
    );
    assert_eq!(replies[1]["result"]["isError"], true, "{replies:?}");
    assert!(
        replies[1]["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("no_repo")
    );
    assert_eq!(
        fs::read_to_string(vault.path().join("a.md")).unwrap(),
        "# A\n"
    );
}

#[test]
fn mcp_defaults_to_docs_folder() {
    let (repo, data) = (repo(), TempDir::new().unwrap());
    let replies = mcp(
        repo.path(),
        data.path(),
        &[],
        &[initialize(), call(1, "list_docs", json!({}))],
    );
    let docs = &replies[1]["result"]["structuredContent"]["docs"];
    let paths: Vec<&str> = docs
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["path"].as_str().unwrap())
        .collect();
    assert_eq!(paths, ["auth.md", "guide.md"], "{replies:?}");
}

#[test]
fn stale_docs_and_get_doc_name_unlinked() {
    let (repo, data) = (repo(), TempDir::new().unwrap());
    let vault = repo.path().join("docs");
    fs::write(
        vault.join("linked.md"),
        "---\ncovers: [nobody:src/**]\nverified: abcdef0\n---\n# Linked\n",
    )
    .unwrap();
    let replies = mcp(
        repo.path(),
        data.path(),
        &[vault.to_str().unwrap()],
        &[
            initialize(),
            call(1, "stale_docs", json!({})),
            call(2, "get_doc", json!({"path":"linked.md"})),
        ],
    );
    let why = "unlinked (a covers prefix names no known repo)";
    let stale = &replies[1]["result"];
    assert_eq!(
        stale["structuredContent"]["docs"],
        json!([{"path":"linked.md","title":"Linked","type":null,"state":"unlinked",
            "covers":["nobody:src/**"],"count":0}]),
        "{stale}"
    );
    assert!(
        stale["content"][0]["text"].as_str().unwrap().contains(why),
        "{stale}"
    );
    let doc = &replies[2]["result"];
    assert_eq!(doc["structuredContent"]["state"], "unlinked", "{doc}");
    assert!(
        doc["content"][0]["text"].as_str().unwrap().contains(why),
        "{doc}"
    );
}
