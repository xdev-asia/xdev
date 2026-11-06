//! JSON-RPC over one reader and one writer: requests with ids and a timeout,
//! notifications both ways, and the few requests a server sends answered by
//! construction.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, PoisonError, mpsc};
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};

use crate::LspError;
use crate::framing::{read_message, write_message};

/// Called on the reader thread for each notification the server sends.
pub type OnNotify = Box<dyn Fn(&str, Value) + Send>;
/// Called once on the reader thread when the server's output ends.
pub type OnClose = Box<dyn FnOnce() + Send>;

/// An error object the server answered with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

type Reply = Result<Value, RpcError>;

/// JSON-RPC's "method not found".
pub const METHOD_NOT_FOUND: i64 = -32601;

struct Pending {
    waiters: HashMap<i64, mpsc::Sender<Reply>>,
    /// Set once the reader stopped; no waiter is added after.
    closed: bool,
}

struct Shared {
    writer: Mutex<Box<dyn Write + Send>>,
    pending: Mutex<Pending>,
}

impl Shared {
    fn send(&self, v: &Value) -> Result<(), LspError> {
        let mut w = self.writer.lock().unwrap_or_else(PoisonError::into_inner);
        write_message(&mut *w, v).map_err(|e| LspError::Io(e.kind().to_string()))
    }

    fn pending(&self) -> std::sync::MutexGuard<'_, Pending> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

pub struct Connection {
    shared: Arc<Shared>,
    next: AtomicI64,
}

/// What the client answers a request the server sends: the result, or an
/// error code. Edits, documents and commands the server asks for are refused.
pub fn answer(method: &str, params: &Value) -> Result<Value, i64> {
    match method {
        "workspace/configuration" => {
            let n = params["items"].as_array().map_or(0, Vec::len);
            Ok(Value::Array(vec![Value::Null; n]))
        }
        "client/registerCapability"
        | "client/unregisterCapability"
        | "window/workDoneProgress/create"
        // No action picked.
        | "window/showMessageRequest" => Ok(Value::Null),
        "workspace/applyEdit" => Ok(json!({"applied": false})),
        "window/showDocument" => Ok(json!({"success": false})),
        _ => Err(METHOD_NOT_FOUND),
    }
}

impl Connection {
    /// Starts the reader thread over `reader`. `on_notify` gets each
    /// notification; nothing is told when the output ends.
    pub fn start(
        reader: impl BufRead + Send + 'static,
        writer: impl Write + Send + 'static,
        on_notify: OnNotify,
    ) -> Connection {
        Connection::start_with_close(reader, writer, on_notify, Box::new(|| {}))
    }

    /// `start`; `on_close` runs once when the output ends, after every
    /// pending request failed with `Closed`.
    pub fn start_with_close(
        mut reader: impl BufRead + Send + 'static,
        writer: impl Write + Send + 'static,
        on_notify: OnNotify,
        on_close: OnClose,
    ) -> Connection {
        let shared = Arc::new(Shared {
            writer: Mutex::new(Box::new(writer)),
            pending: Mutex::new(Pending {
                waiters: HashMap::new(),
                closed: false,
            }),
        });
        let reading = shared.clone();
        thread::Builder::new()
            .name("lsp-reader".into())
            .spawn(move || {
                loop {
                    match read_message(&mut reader) {
                        Ok(Some(msg)) => dispatch(&reading, msg, &on_notify),
                        Ok(None) => break,
                        Err(e) if e.recoverable() => continue,
                        Err(_) => break,
                    }
                }
                // Dropping the senders fails every waiter with `Closed`.
                let waiters = {
                    let mut p = reading.pending();
                    p.closed = true;
                    std::mem::take(&mut p.waiters)
                };
                drop(waiters);
                on_close();
            })
            .expect("spawn the language server reader");
        Connection {
            shared,
            next: AtomicI64::new(1),
        }
    }

    /// The server's output ended.
    pub fn is_closed(&self) -> bool {
        self.shared.pending().closed
    }

    /// Sends a request and waits up to `timeout` for its answer. On timeout
    /// the server is told to cancel and the answer, if it comes, is dropped.
    pub fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, LspError> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        {
            let mut p = self.shared.pending();
            if p.closed {
                return Err(LspError::Closed);
            }
            p.waiters.insert(id, tx);
        }
        let mut msg = json!({"jsonrpc": "2.0", "id": id, "method": method});
        if !params.is_null() {
            msg["params"] = params;
        }
        if let Err(e) = self.shared.send(&msg) {
            self.shared.pending().waiters.remove(&id);
            return Err(e);
        }
        match rx.recv_timeout(timeout) {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(e)) => Err(LspError::Rpc {
                code: e.code,
                message: e.message,
            }),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.shared.pending().waiters.remove(&id);
                let _ = self.notify("$/cancelRequest", json!({"id": id}));
                Err(LspError::Timeout)
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(LspError::Closed),
        }
    }

    pub fn notify(&self, method: &str, params: Value) -> Result<(), LspError> {
        let mut msg = json!({"jsonrpc": "2.0", "method": method});
        if !params.is_null() {
            msg["params"] = params;
        }
        self.shared.send(&msg)
    }
}

fn dispatch(shared: &Shared, msg: Value, on_notify: &OnNotify) {
    let method = msg["method"].as_str();
    let id = msg.get("id").filter(|id| !id.is_null());
    match (method, id) {
        (Some(method), Some(id)) => {
            let reply = match answer(method, &msg["params"]) {
                Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
                Err(code) => json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {"code": code, "message": format!("{method} is not handled")},
                }),
            };
            let _ = shared.send(&reply);
        }
        (Some(method), None) => {
            let params = msg.get("params").cloned().unwrap_or(Value::Null);
            on_notify(method, params);
        }
        (None, Some(id)) => {
            let Some(id) = id.as_i64() else { return };
            let Some(tx) = shared.pending().waiters.remove(&id) else {
                // Late (timed out) or never asked.
                return;
            };
            let reply = match msg.get("error") {
                Some(e) if !e.is_null() => Err(RpcError {
                    code: e["code"].as_i64().unwrap_or(0),
                    message: e["message"].as_str().unwrap_or_default().to_owned(),
                }),
                _ => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
            };
            let _ = tx.send(reply);
        }
        (None, None) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, PipeReader, PipeWriter, pipe};
    use std::time::Instant;

    /// The far end of a connection: what the client wrote, and a pipe to
    /// answer on.
    struct Peer {
        from_client: BufReader<PipeReader>,
        to_client: Option<PipeWriter>,
    }

    impl Peer {
        fn read(&mut self) -> Value {
            read_message(&mut self.from_client).unwrap().unwrap()
        }

        fn write(&mut self, v: Value) {
            write_message(self.to_client.as_mut().unwrap(), &v).unwrap();
        }
    }

    fn connect(on_notify: OnNotify) -> (Connection, Peer, mpsc::Receiver<()>) {
        let (client_in, server_out) = pipe().unwrap();
        let (server_in, client_out) = pipe().unwrap();
        let (closed_tx, closed_rx) = mpsc::channel();
        let conn = Connection::start_with_close(
            BufReader::new(client_in),
            client_out,
            on_notify,
            Box::new(move || {
                let _ = closed_tx.send(());
            }),
        );
        let peer = Peer {
            from_client: BufReader::new(server_in),
            to_client: Some(server_out),
        };
        (conn, peer, closed_rx)
    }

    #[test]
    fn replies_out_of_order_reach_their_requests() {
        let (conn, mut peer, _closed) = connect(Box::new(|_, _| {}));
        let conn = Arc::new(conn);
        let a = {
            let c = conn.clone();
            thread::spawn(move || c.request("a", json!({}), Duration::from_secs(5)))
        };
        let first = peer.read();
        let b = {
            let c = conn.clone();
            thread::spawn(move || c.request("b", Value::Null, Duration::from_secs(5)))
        };
        let second = peer.read();
        assert_eq!(first["method"], "a");
        assert_eq!(second["method"], "b");
        assert!(second.get("params").is_none());
        peer.write(json!({"jsonrpc": "2.0", "id": second["id"], "result": "B"}));
        peer.write(json!({"jsonrpc": "2.0", "id": first["id"], "error": {"code": -32800, "message": "cancelled"}}));
        assert_eq!(b.join().unwrap(), Ok(json!("B")));
        assert_eq!(
            a.join().unwrap(),
            Err(LspError::Rpc {
                code: -32800,
                message: "cancelled".into()
            })
        );
    }

    #[test]
    fn a_timeout_sends_cancel_and_drops_the_late_answer() {
        let (conn, mut peer, _closed) = connect(Box::new(|_, _| {}));
        let started = Instant::now();
        let r = conn.request("slow", json!({}), Duration::from_millis(50));
        assert_eq!(r, Err(LspError::Timeout));
        assert!(started.elapsed() >= Duration::from_millis(50));
        let req = peer.read();
        let cancel = peer.read();
        assert_eq!(cancel["method"], "$/cancelRequest");
        assert_eq!(cancel["params"]["id"], req["id"]);
        // The late answer goes nowhere; the next request still works.
        peer.write(json!({"jsonrpc": "2.0", "id": req["id"], "result": 1}));
        let next = thread::spawn(move || {
            let r = conn.request("next", json!({}), Duration::from_secs(5));
            (conn, r)
        });
        let req = peer.read();
        peer.write(json!({"jsonrpc": "2.0", "id": req["id"], "result": 2}));
        assert_eq!(next.join().unwrap().1, Ok(json!(2)));
    }

    #[test]
    fn server_requests_are_answered_by_construction() {
        let (_conn, mut peer, _closed) = connect(Box::new(|_, _| {}));
        peer.write(json!({"jsonrpc": "2.0", "id": 7, "method": "workspace/applyEdit", "params": {"edit": {}}}));
        assert_eq!(
            peer.read(),
            json!({"jsonrpc": "2.0", "id": 7, "result": {"applied": false}})
        );
        peer.write(json!({"jsonrpc": "2.0", "id": "c", "method": "workspace/configuration", "params": {"items": [{}, {}]}}));
        assert_eq!(
            peer.read(),
            json!({"jsonrpc": "2.0", "id": "c", "result": [null, null]})
        );
        peer.write(json!({"jsonrpc": "2.0", "id": 8, "method": "workspace/executeCommand"}));
        assert_eq!(peer.read()["error"]["code"], METHOD_NOT_FOUND);
    }

    #[test]
    fn answer_table() {
        assert_eq!(
            answer("window/showDocument", &Value::Null),
            Ok(json!({"success": false}))
        );
        assert_eq!(
            answer("client/registerCapability", &Value::Null),
            Ok(Value::Null)
        );
        assert_eq!(
            answer("window/workDoneProgress/create", &Value::Null),
            Ok(Value::Null)
        );
        assert_eq!(answer("workspace/configuration", &json!({})), Ok(json!([])));
        assert_eq!(answer("anything/else", &Value::Null), Err(METHOD_NOT_FOUND));
    }

    #[test]
    fn notifications_reach_the_callback() {
        let (tx, rx) = mpsc::channel();
        let (_conn, mut peer, _closed) = connect(Box::new(move |m, p| {
            let _ = tx.send((m.to_owned(), p));
        }));
        peer.write(json!({"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics", "params": {"uri": "file:///a"}}));
        let (m, p) = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(m, "textDocument/publishDiagnostics");
        assert_eq!(p["uri"], "file:///a");
    }

    #[test]
    fn eof_fails_every_pending_request_and_later_ones() {
        let (conn, mut peer, closed) = connect(Box::new(|_, _| {}));
        let conn = Arc::new(conn);
        let waiting = {
            let c = conn.clone();
            thread::spawn(move || c.request("a", json!({}), Duration::from_secs(30)))
        };
        let _ = peer.read();
        peer.to_client = None;
        assert_eq!(waiting.join().unwrap(), Err(LspError::Closed));
        closed.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(conn.is_closed());
        assert_eq!(
            conn.request("b", json!({}), Duration::from_secs(30)),
            Err(LspError::Closed)
        );
    }
}
