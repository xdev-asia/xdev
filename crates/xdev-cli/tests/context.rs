use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tempfile::TempDir;

fn server(count: usize) -> (String, thread::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let handle = thread::spawn(move || {
        let mut requests = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        while requests.len() < count {
            let (mut stream, _) = match listener.accept() {
                Ok(stream) => stream,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < deadline, "missing Ollama request");
                    thread::sleep(Duration::from_millis(10));
                    continue;
                }
                Err(e) => panic!("{e}"),
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut header = Vec::new();
            let mut byte = [0];
            while !header.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                header.push(byte[0]);
            }
            let header = String::from_utf8(header).unwrap();
            assert!(header.starts_with("POST /api/embed HTTP/1.1"));
            let length = header
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                })
                .unwrap();
            let mut bytes = vec![0; length];
            stream.read_exact(&mut bytes).unwrap();
            let request: Value = serde_json::from_slice(&bytes).unwrap();
            let vectors = request["input"]
                .as_array()
                .unwrap()
                .iter()
                .map(|_| vec![1.0, 0.5])
                .collect::<Vec<_>>();
            let body = json!({"embeddings":vectors}).to_string();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
            requests.push(request);
        }
        requests
    });
    (url, handle)
}

fn command(data: &Path, url: &str) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_xdev"));
    command
        .env("XDEV_DATA_DIR", data)
        .env("XDEV_OLLAMA_URL", url)
        .env("XDEV_EMBED_MODEL", "test-model");
    command
}
fn success(out: Output) -> String {
    assert!(out.status.success(), "{out:?}");
    String::from_utf8(out.stdout).unwrap()
}
fn fixture() -> (TempDir, TempDir) {
    let vault = TempDir::new().unwrap();
    fs::write(
        vault.path().join("a.md"),
        "---\ncovers: [src/**]\n---\n# Auth\nTokens rotate daily.\n## Storage\nEncrypted keys.",
    )
    .unwrap();
    (vault, TempDir::new().unwrap())
}

#[test]
fn embed_incremental_model_override_and_context_json() {
    let (vault, data) = fixture();
    let dir = vault.path().to_str().unwrap();
    let (url, handle) = server(4);
    assert_eq!(
        success(
            command(data.path(), &url)
                .args(["embed", dir])
                .output()
                .unwrap()
        ),
        "embedded\t2\nkept\t0\nremoved\t0\n"
    );
    assert_eq!(
        success(
            command(data.path(), &url)
                .args(["embed", dir])
                .output()
                .unwrap()
        ),
        "embedded\t0\nkept\t2\nremoved\t0\n"
    );
    let out = success(
        command(data.path(), &url)
            .args(["context", dir, "Tokens", "--json"])
            .output()
            .unwrap(),
    );
    let pack: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(pack["mode"], "hybrid");
    assert_eq!(pack["sections"][0]["path"], "a.md");
    assert_eq!(pack["sections"][0]["stale"], true);
    assert_eq!(
        success(
            command(data.path(), &url)
                .args(["embed", dir, "--model", "override"])
                .output()
                .unwrap()
        ),
        "embedded\t2\nkept\t0\nremoved\t0\n"
    );
    success(
        command(data.path(), &url)
            .args(["embed", dir])
            .output()
            .unwrap(),
    );
    let requests = handle.join().unwrap();
    assert_eq!(requests[0]["model"], "test-model");
    assert_eq!(requests[1]["input"], json!(["Tokens"]));
    assert_eq!(requests[2]["model"], "override");
    fs::remove_file(vault.path().join("a.md")).unwrap();
    assert_eq!(
        success(
            command(data.path(), &url)
                .args(["embed", dir])
                .output()
                .unwrap()
        ),
        "embedded\t0\nkept\t0\nremoved\t2\n"
    );
}

fn mcp(data: &Path, url: &str, dir: &str, budget: Option<usize>) -> Value {
    let mut args = json!({"query":"Tokens"});
    if let Some(budget) = budget {
        args["budget"] = json!(budget);
    }
    let mut child = command(data, url)
        .args(["mcp", dir])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    writeln!(child.stdin.take().unwrap(), "{}", json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"context_pack","arguments":args}})).unwrap();
    serde_json::from_str(&success(child.wait_with_output().unwrap())).unwrap()
}

#[test]
fn mcp_context_matches_cli_and_preserves_sections() {
    let (vault, data) = fixture();
    let dir = vault.path().to_str().unwrap();
    let (url, handle) = server(4);
    success(
        command(data.path(), &url)
            .args(["embed", dir])
            .output()
            .unwrap(),
    );
    let cli: Value = serde_json::from_str(&success(
        command(data.path(), &url)
            .args(["context", dir, "Tokens", "--json"])
            .output()
            .unwrap(),
    ))
    .unwrap();
    let reply = mcp(data.path(), &url, dir, None);
    assert_eq!(reply["result"]["structuredContent"], cli);
    assert!(
        reply["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Source: a.md | stale: true")
    );
    let reply = mcp(data.path(), &url, dir, Some(1));
    assert_eq!(reply["result"]["structuredContent"]["sections"], json!([]));
    handle.join().unwrap();
}

#[test]
fn unreachable_embed_errors_and_context_falls_back() {
    let (vault, data) = fixture();
    let dir = vault.path().to_str().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let out = command(data.path(), &url)
        .args(["embed", dir])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(
        String::from_utf8(out.stderr).unwrap(),
        "error: ollama_unreachable\n"
    );
    let out = command(data.path(), &url)
        .args(["context", dir, "Tokens"])
        .output()
        .unwrap();
    assert!(out.status.success());
    assert_eq!(String::from_utf8(out.stderr).unwrap(), "mode: keyword\n");
    assert!(
        String::from_utf8(out.stdout)
            .unwrap()
            .contains("Tokens rotate daily.")
    );
    let (live_url, handle) = server(1);
    success(
        command(data.path(), &live_url)
            .args(["embed", dir])
            .output()
            .unwrap(),
    );
    handle.join().unwrap();
    let reply = mcp(data.path(), &url, dir, None);
    assert_eq!(reply["result"]["structuredContent"]["mode"], "keyword");
    assert!(
        !reply["result"]["structuredContent"]["sections"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
