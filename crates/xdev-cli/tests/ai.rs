use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::Duration;

use tempfile::TempDir;

fn command(data: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_xdev"));
    command
        .env("XDEV_DATA_DIR", data)
        .env("XDEV_SECRETS", "memory");
    command
}

fn run(data: &Path, args: &[&str], input: &str) -> Output {
    let mut child = command(data)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

#[test]
fn keys_persist_and_never_appear_in_output() {
    let data = TempDir::new().unwrap();
    let empty = "anthropic\tunset\nopenai\tunset\ngemini\tunset\n";
    assert_eq!(
        String::from_utf8(run(data.path(), &["ai", "key", "list"], "").stdout).unwrap(),
        empty
    );
    for provider in ["anthropic", "openai", "gemini"] {
        let out = run(
            data.path(),
            &["ai", "key", "set", provider],
            "  dummy-placeholder  \nignored-second-line\n",
        );
        assert!(out.status.success());
        assert!(out.stdout.is_empty());
        assert!(out.stderr.is_empty());
    }
    let out = run(data.path(), &["ai", "key", "list"], "");
    assert!(out.status.success());
    assert_eq!(
        String::from_utf8(out.stdout).unwrap(),
        "anthropic\tset\nopenai\tset\ngemini\tset\n"
    );
    let keys: serde_json::Value =
        serde_json::from_slice(&std::fs::read(data.path().join("test-secrets.json")).unwrap())
            .unwrap();
    assert!(keys["openai"].as_str() == Some("dummy-placeholder"));
    for provider in ["anthropic", "openai", "gemini", "openai"] {
        let out = run(data.path(), &["ai", "key", "remove", provider], "");
        assert!(out.status.success());
        assert!(out.stdout.is_empty());
        assert!(out.stderr.is_empty());
    }
    assert_eq!(
        String::from_utf8(run(data.path(), &["ai", "key", "list"], "").stdout).unwrap(),
        empty
    );
}

#[test]
fn unknown_provider_and_bad_fake_fail_with_codes() {
    let data = TempDir::new().unwrap();
    for action in ["set", "remove"] {
        let out = run(data.path(), &["ai", "key", action, "unknown"], "");
        assert_eq!(out.status.code(), Some(1));
        assert!(out.stdout.is_empty());
        assert_eq!(
            String::from_utf8(out.stderr).unwrap(),
            "error: unknown_provider\n"
        );
    }
    std::fs::write(data.path().join("test-secrets.json"), "invalid-placeholder").unwrap();
    let out = run(data.path(), &["ai", "key", "list"], "");
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(
        String::from_utf8(out.stderr).unwrap(),
        "error: secret_store\n"
    );
}

#[test]
fn models_uses_environment_url_and_reports_errors() {
    let data = TempDir::new().unwrap();
    for (status, body, expected) in [
        (
            200,
            r#"{"models":[{"name":"llama3"},{"name":"nomic-embed-text"}]}"#,
            "llama3\nnomic-embed-text\n",
        ),
        (500, "failed", "error: ollama_error\n"),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            assert!(request.starts_with(b"GET /api/tags HTTP/1.1"));
            write!(
                stream,
                "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        });
        let out = command(data.path())
            .env("XDEV_OLLAMA_URL", url)
            .args(["ai", "models"])
            .output()
            .unwrap();
        server.join().unwrap();
        assert_eq!(out.status.success(), status == 200);
        assert_eq!(
            String::from_utf8(if status == 200 {
                out.stdout
            } else {
                out.stderr
            })
            .unwrap(),
            expected
        );
    }
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let out = command(data.path())
        .env("XDEV_OLLAMA_URL", url)
        .args(["ai", "models"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(
        String::from_utf8(out.stderr).unwrap(),
        "error: ollama_unreachable\n"
    );
}
