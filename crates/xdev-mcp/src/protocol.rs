//! JSON-RPC 2.0 over newline-delimited stdio, serving both MCP eras: the
//! `initialize` handshake (2025-11-25 and earlier) and per-request `_meta`
//! (2026-07-28). No state is kept between lines, so a client may skip
//! `initialize`, and a broken line cannot poison the ones after it.

use std::io::{BufRead, Write};

use serde_json::{Map, Value, json};

use crate::app_tools::{Host, NoApp};
use crate::{Docs, SUPPORTED, tools};

const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
pub(crate) const INVALID_PARAMS: i64 = -32602;
const UNSUPPORTED_VERSION: i64 = -32022;

/// Versions that carry their version in `_meta` instead of negotiating it once.
const PER_REQUEST: &[&str] = &["2026-07-28"];

const META_VERSION: &str = "io.modelcontextprotocol/protocolVersion";
const META_CAPABILITIES: &str = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER_INFO: &str = "io.modelcontextprotocol/serverInfo";

/// Identity only changes with a new build, which restarts the process.
const TTL_MS: u64 = 3_600_000;
/// The tool list also follows the person's switches in Settings → MCP.
const LIST_TTL_MS: u64 = 30_000;

pub(crate) struct RpcError {
    code: i64,
    message: String,
    data: Option<Value>,
}

impl RpcError {
    pub(crate) fn new(code: i64, message: impl Into<String>) -> Self {
        RpcError {
            code,
            message: message.into(),
            data: None,
        }
    }
}

/// Serves until EOF on `input`. Errors only on I/O failure of `output`.
pub fn serve(
    docs: &mut dyn Docs,
    input: impl BufRead,
    output: impl Write,
    version: &str,
) -> std::io::Result<()> {
    serve_with(docs, &mut NoApp, input, output, version)
}

/// [`serve`] with the app tools of `host`.
pub fn serve_with(
    docs: &mut dyn Docs,
    host: &mut dyn Host,
    mut input: impl BufRead,
    mut output: impl Write,
    version: &str,
) -> std::io::Result<()> {
    let mut server = Server {
        docs,
        host,
        version,
    };
    let mut line = Vec::new();
    loop {
        line.clear();
        // A failing stdin means the client is gone; like EOF, there is no one left to answer.
        let oversized = match read_line(&mut input, &mut line, MAX_MESSAGE_BYTES) {
            Ok(Some(oversized)) => oversized,
            Ok(None) | Err(_) => return Ok(()),
        };
        let reply = if oversized {
            Some(invalid(Value::Null, "message exceeds 16 MiB"))
        } else {
            let message = line.trim_ascii();
            if message.is_empty() {
                continue;
            }
            server.handle(message)
        };
        if let Some(reply) = reply {
            let mut bytes = serde_json::to_vec(&reply).map_err(std::io::Error::other)?;
            bytes.push(b'\n');
            output.write_all(&bytes)?;
            output.flush()?;
        }
    }
}

fn read_line(
    input: &mut impl BufRead,
    line: &mut Vec<u8>,
    limit: usize,
) -> std::io::Result<Option<bool>> {
    let mut oversized = false;
    loop {
        let available = input.fill_buf()?;
        if available.is_empty() {
            return Ok((oversized || !line.is_empty()).then_some(oversized));
        }
        let newline = available.iter().position(|&byte| byte == b'\n');
        let count = newline.unwrap_or(available.len());
        // Keep draining an oversized line without retaining its remainder.
        if !oversized {
            let keep = count.min(limit - line.len());
            line.extend_from_slice(&available[..keep]);
            oversized = keep < count;
        }
        input.consume(count + usize::from(newline.is_some()));
        if newline.is_some() {
            return Ok(Some(oversized));
        }
    }
}

struct Server<'a> {
    docs: &'a mut dyn Docs,
    host: &'a mut dyn Host,
    version: &'a str,
}

impl Server<'_> {
    fn handle(&mut self, line: &[u8]) -> Option<Value> {
        // `from_slice` rejects invalid UTF-8, so such a line is a parse error.
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            return Some(error(
                Value::Null,
                RpcError::new(PARSE_ERROR, "Parse error"),
            ));
        };
        let Value::Object(msg) = value else {
            return Some(invalid(
                Value::Null,
                "expected one JSON-RPC object per line",
            ));
        };
        let id = msg.get("id").filter(|id| is_valid_id(id)).cloned();
        let Some(method) = msg.get("method").and_then(Value::as_str) else {
            // We never send requests, so a stray response has nothing to match.
            if !msg.contains_key("method")
                && (msg.contains_key("result") || msg.contains_key("error"))
            {
                return None;
            }
            return Some(invalid(
                id.unwrap_or(Value::Null),
                "missing string `method`",
            ));
        };
        if !msg.contains_key("id") {
            // Notifications (`notifications/initialized`, `notifications/cancelled`)
            // need nothing from a server that keeps no state.
            return None;
        }
        let Some(id) = id else {
            return Some(invalid(Value::Null, "`id` must be a string or an integer"));
        };
        if msg.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return Some(invalid(id, "`jsonrpc` must be \"2.0\""));
        }
        let params = match msg.get("params") {
            None => Map::new(),
            Some(Value::Object(params)) => params.clone(),
            Some(_) => {
                return Some(error(
                    id,
                    RpcError::new(INVALID_PARAMS, "`params` must be an object"),
                ));
            }
        };
        Some(match self.dispatch(method, &params) {
            Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
            Err(e) => error(id, e),
        })
    }

    fn dispatch(&mut self, method: &str, params: &Map<String, Value>) -> Result<Value, RpcError> {
        if method == "initialize" {
            return Ok(self.initialize(params));
        }
        let per_request = per_request_version(params)?;
        let mut result = match method {
            "ping" => json!({}),
            "server/discover" => json!({
                "supportedVersions": SUPPORTED,
                "capabilities": {"tools": {}},
                "instructions": tools::instructions(&self.docs.vault_name()),
                "ttlMs": TTL_MS,
                "cacheScope": "private",
            }),
            "tools/list" => {
                let mut list = json!({"tools": tools::definitions(&*self.host)});
                if per_request {
                    // Short, because the person can switch app tools on or off meanwhile.
                    list["ttlMs"] = json!(LIST_TTL_MS);
                    list["cacheScope"] = json!("private");
                }
                list
            }
            "tools/call" => tools::call(self.docs, self.host, params)?,
            _ => {
                return Err(RpcError::new(
                    METHOD_NOT_FOUND,
                    format!("Method not found: {method}"),
                ));
            }
        };
        if per_request || method == "server/discover" {
            result["resultType"] = json!("complete");
            result["_meta"] = json!({ META_SERVER_INFO: self.server_info() });
        }
        Ok(result)
    }

    fn initialize(&self, params: &Map<String, Value>) -> Value {
        let mut handshake = SUPPORTED.iter().filter(|v| !PER_REQUEST.contains(v));
        let newest = handshake.clone().next().copied().unwrap_or_default();
        let version = params
            .get("protocolVersion")
            .and_then(Value::as_str)
            .and_then(|asked| handshake.find(|v| **v == asked).copied())
            .unwrap_or(newest);
        json!({
            "protocolVersion": version,
            "capabilities": {"tools": {}},
            "serverInfo": self.server_info(),
            "instructions": tools::instructions(&self.docs.vault_name()),
        })
    }

    fn server_info(&self) -> Value {
        json!({"name": "xdev", "title": "xDev IDE", "version": self.version})
    }
}

/// Whether the request uses the per-request era, after checking the fields
/// that era requires.
fn per_request_version(params: &Map<String, Value>) -> Result<bool, RpcError> {
    let meta = match params.get("_meta") {
        None => return Ok(false),
        Some(Value::Object(meta)) => meta,
        Some(_) => {
            return Err(RpcError::new(INVALID_PARAMS, "`_meta` must be an object"));
        }
    };
    let Some(version) = meta.get(META_VERSION) else {
        return Ok(false);
    };
    let Some(version) = version.as_str() else {
        return Err(RpcError::new(
            INVALID_PARAMS,
            format!("`_meta.{META_VERSION}` must be a string"),
        ));
    };
    if !SUPPORTED.contains(&version) {
        return Err(RpcError {
            code: UNSUPPORTED_VERSION,
            message: "Unsupported protocol version".to_string(),
            data: Some(json!({"supported": SUPPORTED, "requested": version})),
        });
    }
    // A handshake-era version here only restates what `initialize` agreed on.
    if !PER_REQUEST.contains(&version) {
        return Ok(false);
    }
    if !meta.get(META_CAPABILITIES).is_some_and(Value::is_object) {
        return Err(RpcError::new(
            INVALID_PARAMS,
            format!("`_meta.{META_CAPABILITIES}` is required"),
        ));
    }
    Ok(true)
}

/// MCP narrows JSON-RPC ids to strings and integers; `null` is not allowed.
fn is_valid_id(id: &Value) -> bool {
    match id {
        Value::String(_) => true,
        Value::Number(n) => n.is_i64() || n.is_u64(),
        _ => false,
    }
}

fn invalid(id: Value, detail: &str) -> Value {
    error(
        id,
        RpcError::new(INVALID_REQUEST, format!("Invalid Request: {detail}")),
    )
}

fn error(id: Value, e: RpcError) -> Value {
    let mut body = json!({"code": e.code, "message": e.message});
    if let Some(data) = e.data {
        body["data"] = data;
    }
    json!({"jsonrpc": "2.0", "id": id, "error": body})
}

#[cfg(test)]
mod tests {
    use super::read_line;
    use std::io::BufReader;

    #[test]
    fn bounded_reader_handles_chunk_boundaries() {
        for capacity in [1, 3, 8, 64] {
            let mut input =
                BufReader::with_capacity(capacity, &b"123456789012345\n12345678\n123456789"[..]);
            let mut line = Vec::new();
            assert_eq!(read_line(&mut input, &mut line, 8).unwrap(), Some(true));
            assert_eq!(line, b"12345678");
            line.clear();
            assert_eq!(read_line(&mut input, &mut line, 8).unwrap(), Some(false));
            assert_eq!(line, b"12345678");
            line.clear();
            assert_eq!(read_line(&mut input, &mut line, 8).unwrap(), Some(true));
            assert_eq!(line, b"12345678");
            line.clear();
            assert_eq!(read_line(&mut input, &mut line, 8).unwrap(), None);
        }
    }
}
