use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;
use std::time::Duration;

use xdev_ai::ollama::Ollama;

fn server(status: u16, body: &'static str) -> (Ollama, thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let client = Ollama {
        base: format!("http://{}/", listener.local_addr().unwrap()),
    };
    let handle = thread::spawn(move || {
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
        let headers = String::from_utf8(request.clone()).unwrap();
        let length = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().unwrap())
            })
            .unwrap_or(0);
        let mut body_bytes = vec![0; length];
        stream.read_exact(&mut body_bytes).unwrap();
        request.extend(body_bytes);
        write!(
            stream,
            "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
        String::from_utf8(request).unwrap()
    });
    (client, handle)
}

#[test]
fn lists_models() {
    let (client, handle) = server(
        200,
        r#"{"models":[{"name":"nomic-embed-text"},{"name":"llama3"}]}"#,
    );
    assert_eq!(client.models().unwrap(), ["nomic-embed-text", "llama3"]);
    assert!(handle.join().unwrap().starts_with("GET /api/tags HTTP/1.1"));
}

#[test]
fn embeds_an_input_array() {
    let (client, handle) = server(200, r#"{"embeddings":[[0.5,1.0],[-0.5,0.0]]}"#);
    assert_eq!(
        client.embed("embed-model", &["one", "two"]).unwrap(),
        vec![vec![0.5, 1.0], vec![-0.5, 0.0]]
    );
    let request = handle.join().unwrap();
    assert!(request.starts_with("POST /api/embed HTTP/1.1"));
    let body: serde_json::Value =
        serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(
        body,
        serde_json::json!({"model":"embed-model", "input":["one","two"]})
    );
}

#[test]
fn http_errors_include_status() {
    let (client, handle) = server(302, "redirect");
    let error = client.models().unwrap_err();
    assert_eq!(error.code(), "ollama_error");
    assert!(error.to_string().contains("302"));
    handle.join().unwrap();
    let (client, handle) = server(503, "unavailable");
    let error = client.models().unwrap_err();
    assert_eq!(error.code(), "ollama_error");
    assert!(error.to_string().contains("503"));
    handle.join().unwrap();
    let (client, handle) = server(404, "missing");
    assert_eq!(
        client.embed("missing", &["one"]).unwrap_err().code(),
        "ollama_error"
    );
    handle.join().unwrap();
}

#[test]
fn malformed_responses_fail() {
    for body in ["invalid", r#"{"models":null}"#] {
        let (client, handle) = server(200, body);
        assert_eq!(client.models().unwrap_err().code(), "ollama_error");
        handle.join().unwrap();
    }
    let (client, handle) = server(200, r#"{"embeddings":[]}"#);
    assert_eq!(
        client.embed("model", &["one"]).unwrap_err().code(),
        "ollama_error"
    );
    handle.join().unwrap();
}

#[test]
fn stopped_server_is_unreachable() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let client = Ollama {
        base: format!("http://{}", listener.local_addr().unwrap()),
    };
    drop(listener);
    assert_eq!(client.models().unwrap_err().code(), "ollama_unreachable");
    assert_eq!(
        client.embed("model", &["one"]).unwrap_err().code(),
        "ollama_unreachable"
    );
}
