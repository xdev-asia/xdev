use serde_json::{Value, json};
use xdev_mcp::{Doc, DocInfo, Docs, Hit, SUPPORTED, ToolError, serve};

const MODERN: &str = "2026-07-28";

#[derive(Default)]
struct Fake {
    fail: Option<String>,
    last_limit: Option<usize>,
    last_type: Option<String>,
    proposed: Vec<(String, String, Option<String>)>,
}

impl Fake {
    fn err<T>(&self) -> Option<Result<T, ToolError>> {
        self.fail
            .as_ref()
            .map(|code| Err(ToolError { code: code.clone() }))
    }
}

fn info(path: &str, state: &str, count: usize) -> DocInfo {
    DocInfo {
        path: path.to_string(),
        title: format!("Title of {path}"),
        doc_type: Some("adr".to_string()),
        state: state.to_string(),
        covers: vec!["src/auth".to_string(), "src/**/*.rs".to_string()],
        count,
    }
}

impl Docs for Fake {
    fn vault_name(&self) -> String {
        "demo".to_string()
    }

    fn search(&mut self, query: &str, limit: usize) -> Result<Vec<Hit>, ToolError> {
        if let Some(e) = self.err() {
            return e;
        }
        self.last_limit = Some(limit);
        Ok(vec![
            Hit {
                path: "notes/auth.md".to_string(),
                title: "Auth flow".to_string(),
                snippet: format!("how {query}\nworks"),
            },
            Hit {
                path: "adr/0001.md".to_string(),
                title: "Use tokens".to_string(),
                snippet: "tokens".to_string(),
            },
        ])
    }

    fn get(&mut self, path: &str) -> Result<Doc, ToolError> {
        if let Some(e) = self.err() {
            return e;
        }
        Ok(Doc {
            info: info(path, "stale", 3),
            content: "# Auth\n\nBody text.\n".to_string(),
            backlinks: vec!["index.md".to_string(), "adr/0001.md".to_string()],
        })
    }

    fn list(&mut self, doc_type: Option<&str>) -> Result<Vec<DocInfo>, ToolError> {
        if let Some(e) = self.err() {
            return e;
        }
        self.last_type = doc_type.map(str::to_string);
        let mut plain = info("readme.md", "none", 0);
        plain.doc_type = None;
        plain.covers.clear();
        Ok(vec![info("adr/0001.md", "fresh", 0), plain])
    }

    fn stale(&mut self) -> Result<Vec<DocInfo>, ToolError> {
        if let Some(e) = self.err() {
            return e;
        }
        Ok(vec![
            info("arch.md", "stale", 4),
            info("api.md", "unverified", 0),
        ])
    }

    fn propose(
        &mut self,
        path: &str,
        content: &str,
        summary: Option<&str>,
    ) -> Result<(), ToolError> {
        if let Some(e) = self.err() {
            return e;
        }
        self.proposed.push((
            path.to_string(),
            content.to_string(),
            summary.map(str::to_string),
        ));
        Ok(())
    }
}

fn run_bytes(docs: &mut Fake, input: &[u8]) -> (Vec<Value>, String) {
    let mut out = Vec::new();
    serve(docs, input, &mut out, "9.9.9").expect("serve");
    let text = String::from_utf8(out).expect("utf-8 output");
    let values = text
        .lines()
        .map(|l| serde_json::from_str(l).expect("each output line is JSON"))
        .collect();
    (values, text)
}

fn run(docs: &mut Fake, lines: &[Value]) -> Vec<Value> {
    let input: String = lines.iter().map(|l| format!("{l}\n")).collect();
    run_bytes(docs, input.as_bytes()).0
}

fn one(docs: &mut Fake, msg: Value) -> Value {
    let mut out = run(docs, &[msg]);
    assert_eq!(out.len(), 1, "{out:?}");
    out.remove(0)
}

fn call(docs: &mut Fake, name: &str, args: Value) -> Value {
    let reply = one(
        docs,
        json!({"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":name,"arguments":args}}),
    );
    assert_eq!(reply["id"], 7);
    reply["result"].clone()
}

fn text_of(result: &Value) -> String {
    let content = result["content"].as_array().expect("content array");
    assert_eq!(content.len(), 1);
    assert_eq!(content[0]["type"], "text");
    content[0]["text"].as_str().unwrap().to_string()
}

fn modern_meta() -> Value {
    json!({
        "io.modelcontextprotocol/protocolVersion": MODERN,
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": {"name":"t","version":"1"}
    })
}

#[test]
fn supported_is_newest_first_and_dated() {
    assert_eq!(SUPPORTED[0], MODERN);
    assert!(SUPPORTED.contains(&"2025-11-25"));
    let mut sorted = SUPPORTED.to_vec();
    sorted.sort_unstable_by(|a, b| b.cmp(a));
    assert_eq!(sorted, SUPPORTED);
}

#[test]
fn initialize_echoes_supported_version() {
    for v in ["2025-11-25", "2025-06-18"] {
        let reply = one(
            &mut Fake::default(),
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
                "protocolVersion":v,"capabilities":{},"clientInfo":{"name":"c","version":"1"}}}),
        );
        assert_eq!(reply["jsonrpc"], "2.0");
        assert_eq!(reply["id"], 1);
        let r = &reply["result"];
        assert_eq!(r["protocolVersion"], v);
        assert!(r["capabilities"]["tools"].is_object());
        assert_eq!(r["serverInfo"]["name"], "xdev");
        assert_eq!(r["serverInfo"]["version"], "9.9.9");
        let instructions = r["instructions"].as_str().unwrap();
        assert!(instructions.contains("demo"));
        assert!(instructions.contains("Markdown"));
        assert!(instructions.contains("propose_update"));
        assert!(instructions.contains("approv"));
    }
}

#[test]
fn initialize_falls_back_to_newest() {
    // A handshake can only pick a handshake-era version, so the fallback is the
    // newest of those, not 2026-07-28.
    for v in [json!("1999-01-01"), json!(MODERN), json!(42)] {
        let reply = one(
            &mut Fake::default(),
            json!({"jsonrpc":"2.0","id":"a","method":"initialize","params":{"protocolVersion":v}}),
        );
        assert_eq!(reply["id"], "a");
        assert_eq!(reply["result"]["protocolVersion"], "2025-11-25");
    }
    let reply = one(
        &mut Fake::default(),
        json!({"jsonrpc":"2.0","id":2,"method":"initialize"}),
    );
    assert_eq!(reply["result"]["protocolVersion"], "2025-11-25");
}

#[test]
fn notifications_get_no_reply() {
    let out = run(
        &mut Fake::default(),
        &[
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}),
            json!({"jsonrpc":"2.0","method":"tools/list"}),
            json!({"jsonrpc":"2.0","method":"no/such/method"}),
            json!({"jsonrpc":"2.0","method":"tools/call","params":{"name":"propose_update","arguments":{}}}),
        ],
    );
    assert!(out.is_empty(), "{out:?}");
}

#[test]
fn ping_returns_empty_result() {
    let reply = one(
        &mut Fake::default(),
        json!({"jsonrpc":"2.0","id":3,"method":"ping"}),
    );
    assert_eq!(reply, json!({"jsonrpc":"2.0","id":3,"result":{}}));
}

fn tools(reply: &Value) -> Vec<Value> {
    reply["result"]["tools"].as_array().unwrap().clone()
}

#[test]
fn tools_list_has_five_tools_with_schemas() {
    let reply = one(
        &mut Fake::default(),
        json!({"jsonrpc":"2.0","id":4,"method":"tools/list","params":{}}),
    );
    let tools = tools(&reply);
    let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(
        names,
        [
            "search_docs",
            "get_doc",
            "list_docs",
            "stale_docs",
            "propose_update"
        ]
    );
    let required = |t: &Value| -> Vec<String> {
        t["inputSchema"]["required"]
            .as_array()
            .map(|a| a.iter().map(|v| v.as_str().unwrap().to_string()).collect())
            .unwrap_or_default()
    };
    let expect: [&[&str]; 5] = [&["query"], &["path"], &[], &[], &["path", "content"]];
    for (t, req) in tools.iter().zip(expect) {
        assert_eq!(t["inputSchema"]["type"], "object", "{t}");
        assert_eq!(t["outputSchema"]["type"], "object", "{t}");
        assert!(!t["description"].as_str().unwrap().is_empty());
        assert_eq!(required(t), req, "{t}");
        for name in req {
            assert!(t["inputSchema"]["properties"][name].is_object());
        }
    }
    let limit = &tools[0]["inputSchema"]["properties"]["limit"];
    assert_eq!(limit["minimum"], 1);
    assert_eq!(limit["maximum"], 50);
    assert_eq!(limit["default"], 10);
    assert!(tools[2]["inputSchema"]["properties"]["type"].is_object());
    assert!(tools[4]["inputSchema"]["properties"]["summary"].is_object());
    assert!(reply["result"].get("resultType").is_none());
}

/// Every key the output schema requires is present in the structured result,
/// so clients that validate against `outputSchema` accept it.
#[test]
fn structured_content_has_output_schema_keys() {
    let reply = one(
        &mut Fake::default(),
        json!({"jsonrpc":"2.0","id":4,"method":"tools/list"}),
    );
    let calls = [
        ("search_docs", json!({"query":"auth"})),
        ("get_doc", json!({"path":"a.md"})),
        ("list_docs", json!({})),
        ("stale_docs", json!({})),
        ("propose_update", json!({"path":"a.md","content":"x"})),
    ];
    for (tool, (name, args)) in tools(&reply).iter().zip(calls) {
        assert_eq!(tool["name"], name);
        let result = call(&mut Fake::default(), name, args);
        assert_eq!(result["isError"], false);
        let sc = &result["structuredContent"];
        for key in tool["outputSchema"]["required"].as_array().unwrap() {
            assert!(sc.get(key.as_str().unwrap()).is_some(), "{name}: {key}");
        }
    }
}

#[test]
fn call_search_formats_hits() {
    let mut fake = Fake::default();
    let result = call(&mut fake, "search_docs", json!({"query":"login"}));
    assert_eq!(fake.last_limit, Some(10));
    let text = text_of(&result);
    assert!(text.contains("notes/auth.md"), "{text}");
    assert!(text.contains("Auth flow"));
    assert!(
        text.contains("how login works"),
        "snippet on one line: {text}"
    );
    assert!(text.find("notes/auth.md") < text.find("adr/0001.md"));
    assert_eq!(
        result["structuredContent"]["hits"],
        json!([
            {"path":"notes/auth.md","title":"Auth flow","snippet":"how login\nworks"},
            {"path":"adr/0001.md","title":"Use tokens","snippet":"tokens"}
        ])
    );
    let again = call(
        &mut Fake::default(),
        "search_docs",
        json!({"query":"login"}),
    );
    assert_eq!(again, result, "deterministic");
}

#[test]
fn call_get_doc_has_header_and_content() {
    let result = call(
        &mut Fake::default(),
        "get_doc",
        json!({"path":"notes/auth.md"}),
    );
    let text = text_of(&result);
    let (header, rest) = text.split_once('\n').unwrap();
    assert!(header.contains("notes/auth.md"), "{header}");
    assert!(header.contains("Title of notes/auth.md"));
    assert!(header.contains("stale"));
    assert!(header.contains("index.md, adr/0001.md"));
    assert!(rest.ends_with("# Auth\n\nBody text.\n"), "{rest}");
    let sc = &result["structuredContent"];
    assert_eq!(sc["path"], "notes/auth.md");
    assert_eq!(sc["type"], "adr");
    assert_eq!(sc["state"], "stale");
    assert_eq!(sc["count"], 3);
    assert_eq!(sc["covers"], json!(["src/auth", "src/**/*.rs"]));
    assert_eq!(sc["backlinks"], json!(["index.md", "adr/0001.md"]));
    assert_eq!(sc["content"], "# Auth\n\nBody text.\n");
}

#[test]
fn call_list_and_stale_format_one_line_per_doc() {
    let mut fake = Fake::default();
    let result = call(&mut fake, "list_docs", json!({"type":"adr"}));
    assert_eq!(fake.last_type.as_deref(), Some("adr"));
    let text = text_of(&result);
    let line = text.lines().find(|l| l.contains("adr/0001.md")).unwrap();
    assert!(line.contains("Title of adr/0001.md") && line.contains("adr"));
    assert!(line.contains("fresh"));
    assert!(text.lines().any(|l| l.contains("readme.md")));
    assert_eq!(result["structuredContent"]["docs"][1]["type"], Value::Null);

    let mut fake = Fake::default();
    call(&mut fake, "list_docs", json!({}));
    assert_eq!(fake.last_type, None);

    let result = call(&mut Fake::default(), "stale_docs", json!({}));
    let text = text_of(&result);
    let line = text.lines().find(|l| l.contains("arch.md")).unwrap();
    assert!(line.contains("stale") && line.contains('4') && line.contains("src/**/*.rs"));
    let line = text.lines().find(|l| l.contains("api.md")).unwrap();
    assert!(line.contains("unverified") && line.contains("src/auth"));
    assert_eq!(result["structuredContent"]["docs"][0]["count"], 4);
}

#[test]
fn call_propose_reports_review() {
    let mut fake = Fake::default();
    let result = call(
        &mut fake,
        "propose_update",
        json!({"path":"a.md","content":"new","summary":"fix typo"}),
    );
    assert_eq!(
        fake.proposed,
        [(
            "a.md".to_string(),
            "new".to_string(),
            Some("fix typo".to_string())
        )]
    );
    let text = text_of(&result);
    assert!(text.contains("a.md"));
    assert!(text.contains("review"));
    assert!(text.contains("Changes tab"));
    assert_eq!(result["structuredContent"]["status"], "pending_review");

    let mut fake = Fake::default();
    call(
        &mut fake,
        "propose_update",
        json!({"path":"b.md","content":""}),
    );
    assert_eq!(fake.proposed[0].2, None);
}

#[test]
fn tool_error_is_result_with_is_error() {
    let mut fake = Fake {
        fail: Some("conflict".to_string()),
        ..Fake::default()
    };
    let result = call(
        &mut fake,
        "propose_update",
        json!({"path":"a.md","content":"x"}),
    );
    assert_eq!(result["isError"], true);
    assert!(text_of(&result).contains("conflict"));
    assert!(result.get("structuredContent").is_none());

    for code in ["not_found", "outside_vault", "no_repo", "something_new"] {
        let mut fake = Fake {
            fail: Some(code.to_string()),
            ..Fake::default()
        };
        let result = call(&mut fake, "get_doc", json!({"path":"a.md"}));
        assert_eq!(result["isError"], true);
        assert!(text_of(&result).contains(code));
    }
}

fn error_code(reply: &Value) -> i64 {
    assert!(reply.get("result").is_none(), "{reply}");
    assert!(reply["error"]["message"].is_string());
    reply["error"]["code"].as_i64().unwrap()
}

#[test]
fn unknown_tool_and_bad_params_are_rpc_errors() {
    let bad = [
        json!({"name":"nope","arguments":{}}),
        json!({"arguments":{}}),
        json!({"name":"get_doc","arguments":[]}),
        json!({"name":"get_doc"}),
        json!({"name":"get_doc","arguments":{"path":5}}),
        json!({"name":"search_docs","arguments":{"query":"x","limit":"ten"}}),
        json!({"name":"list_docs","arguments":{"type":1}}),
        json!({"name":"propose_update","arguments":{"path":"a.md"}}),
        json!({"name":"propose_update","arguments":{"path":"a.md","content":"x","summary":3}}),
    ];
    for params in bad {
        let reply = one(
            &mut Fake::default(),
            json!({"jsonrpc":"2.0","id":9,"method":"tools/call","params":params}),
        );
        assert_eq!(reply["id"], 9);
        assert_eq!(error_code(&reply), -32602, "{params}");
    }
    for params in [json!([1]), json!("x")] {
        let reply = one(
            &mut Fake::default(),
            json!({"jsonrpc":"2.0","id":9,"method":"tools/list","params":params}),
        );
        assert_eq!(error_code(&reply), -32602);
    }
    let reply = one(
        &mut Fake::default(),
        json!({"jsonrpc":"2.0","id":9,"method":"tools/call"}),
    );
    assert_eq!(error_code(&reply), -32602);
}

#[test]
fn unknown_method_is_method_not_found() {
    let reply = one(
        &mut Fake::default(),
        json!({"jsonrpc":"2.0","id":"x","method":"resources/list"}),
    );
    assert_eq!(reply["id"], "x");
    assert_eq!(error_code(&reply), -32601);
}

#[test]
fn limit_is_clamped_to_1_50() {
    for (given, used) in [
        (json!(0), 1),
        (json!(-5), 1),
        (json!(500), 50),
        (json!(7), 7),
        (json!(7.9), 7),
        (json!(null), 10),
    ] {
        let mut fake = Fake::default();
        call(&mut fake, "search_docs", json!({"query":"q","limit":given}));
        assert_eq!(fake.last_limit, Some(used), "{given}");
    }
}

#[test]
fn bad_lines_do_not_stop_the_server() {
    let mut input = Vec::new();
    input.extend_from_slice(b"not json\n");
    input.extend_from_slice(b"\n   \r\n");
    input.extend_from_slice(b"[]\n");
    input.extend_from_slice(b"{\"jsonrpc\":\"2.0\"}\n");
    input.extend_from_slice(
        b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\",\"x\":\"\xff\xfe\"}\n",
    );
    input.extend_from_slice(b"{\"jsonrpc\":\"1.0\",\"id\":2,\"method\":\"ping\"}\n");
    input.extend_from_slice(b"{\"jsonrpc\":\"2.0\",\"id\":null,\"method\":\"ping\"}\n");
    input.extend_from_slice(b"{\"jsonrpc\":\"2.0\",\"id\":{},\"method\":\"ping\"}\n");
    input.extend_from_slice(b"{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":7}\n");
    input.extend_from_slice(b"{\"jsonrpc\":\"2.0\",\"id\":4,\"result\":{}}\n");
    input.extend_from_slice(b"\"str\"\n");
    input.extend_from_slice(b"{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"ping\"}\r\n");
    // The last line has no newline: EOF ends it.
    input.extend_from_slice(b"{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"ping\"}");
    let (out, raw) = run_bytes(&mut Fake::default(), &input);
    assert!(raw.ends_with('\n'));
    let got: Vec<(Value, i64)> = out
        .iter()
        .map(|r| {
            let code = r.get("error").map_or(0, |_| error_code(r));
            (r["id"].clone(), code)
        })
        .collect();
    assert_eq!(
        got,
        [
            (Value::Null, -32700),
            (Value::Null, -32600),
            (Value::Null, -32600),
            (Value::Null, -32700),
            (json!(2), -32600),
            (Value::Null, -32600),
            (Value::Null, -32600),
            (json!(3), -32600),
            (Value::Null, -32600),
            (json!(5), 0),
            (json!(6), 0),
        ]
    );
    for r in &out {
        assert_eq!(r["jsonrpc"], "2.0");
    }
}

#[test]
fn output_is_one_line_per_message() {
    let (out, raw) = run_bytes(
        &mut Fake::default(),
        b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"get_doc\",\"arguments\":{\"path\":\"a.md\"}}}\n",
    );
    assert_eq!(out.len(), 1);
    assert_eq!(raw.matches('\n').count(), 1);
}

#[test]
fn discover_lists_versions_and_tools() {
    let reply = one(
        &mut Fake::default(),
        json!({"jsonrpc":"2.0","id":"d","method":"server/discover","params":{"_meta":modern_meta()}}),
    );
    let r = &reply["result"];
    assert_eq!(r["resultType"], "complete");
    assert_eq!(r["supportedVersions"], json!(SUPPORTED));
    assert!(r["capabilities"]["tools"].is_object());
    assert_eq!(
        r["_meta"]["io.modelcontextprotocol/serverInfo"]["name"],
        "xdev"
    );
    assert!(
        r["instructions"]
            .as_str()
            .unwrap()
            .contains("propose_update")
    );
    assert!(r["ttlMs"].as_u64().is_some());
    // The instructions name this vault, so no shared cache should reuse them.
    assert_eq!(r["cacheScope"], "private");
}

#[test]
fn modern_requests_get_result_type_and_server_info() {
    let reply = one(
        &mut Fake::default(),
        json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":modern_meta()}}),
    );
    let r = &reply["result"];
    assert_eq!(r["resultType"], "complete");
    assert_eq!(
        r["_meta"]["io.modelcontextprotocol/serverInfo"]["version"],
        "9.9.9"
    );
    assert!(r["ttlMs"].as_u64().is_some());
    assert_eq!(r["cacheScope"], "public");
    assert_eq!(r["tools"].as_array().unwrap().len(), 5);

    let reply = one(
        &mut Fake::default(),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
            "_meta":modern_meta(),"name":"get_doc","arguments":{"path":"a.md"}}}),
    );
    assert_eq!(reply["result"]["resultType"], "complete");
    assert_eq!(reply["result"]["isError"], false);
    assert!(reply["result"].get("ttlMs").is_none());
}

#[test]
fn modern_unsupported_version_is_rejected() {
    let mut meta = modern_meta();
    meta["io.modelcontextprotocol/protocolVersion"] = json!("1900-01-01");
    let reply = one(
        &mut Fake::default(),
        json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":meta}}),
    );
    assert_eq!(error_code(&reply), -32022);
    assert_eq!(
        reply["error"]["data"],
        json!({"supported": SUPPORTED, "requested": "1900-01-01"})
    );
}

#[test]
fn modern_request_missing_fields_is_invalid_params() {
    let mut no_caps = modern_meta();
    no_caps
        .as_object_mut()
        .unwrap()
        .remove("io.modelcontextprotocol/clientCapabilities");
    let mut bad_version = modern_meta();
    bad_version["io.modelcontextprotocol/protocolVersion"] = json!(2026);
    for meta in [no_caps, bad_version] {
        let reply = one(
            &mut Fake::default(),
            json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":meta}}),
        );
        assert_eq!(error_code(&reply), -32602);
    }
}
