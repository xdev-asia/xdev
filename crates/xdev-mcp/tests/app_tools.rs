//! The app tools through the JSON-RPC surface, with a fake app and no process.

use std::collections::BTreeMap;

use serde_json::{Value, json};
use xdev_mcp::{
    ActivityEntry, Doc, DocInfo, Docs, EndpointError, Hit, Host, ToolError, serve_with,
};

struct NoDocs;

impl Docs for NoDocs {
    fn vault_name(&self) -> String {
        "demo".into()
    }
    fn context_pack(&mut self, _: &str, _: usize) -> Result<xdev_mcp::ContextPack, ToolError> {
        Ok(xdev_mcp::ContextPack {
            mode: "keyword".into(),
            sections: vec![],
        })
    }
    fn search(&mut self, _: &str, _: usize) -> Result<Vec<Hit>, ToolError> {
        Ok(vec![])
    }
    fn get(&mut self, _: &str) -> Result<Doc, ToolError> {
        Err(ToolError {
            code: "not_found".into(),
        })
    }
    fn list(&mut self, _: Option<&str>) -> Result<Vec<DocInfo>, ToolError> {
        Ok(vec![])
    }
    fn stale(&mut self) -> Result<Vec<DocInfo>, ToolError> {
        Ok(vec![])
    }
    fn propose(&mut self, _: &str, _: &str, _: Option<&str>) -> Result<(), ToolError> {
        Ok(())
    }
}

#[derive(Default)]
struct FakeApp {
    on: BTreeMap<String, bool>,
    down: bool,
    sent: Vec<(String, Value)>,
    log: Vec<ActivityEntry>,
}

impl Host for FakeApp {
    fn enabled(&self, tool: &str) -> bool {
        self.on
            .get(tool)
            .copied()
            .unwrap_or_else(|| xdev_mcp::app_tools::find(tool).is_some_and(|t| t.default_on))
    }
    fn call(&mut self, method: &str, params: Value) -> Result<Value, EndpointError> {
        self.sent.push((method.into(), params));
        if self.down {
            return Err(EndpointError {
                code: "app_not_running".into(),
                message: "xDev is not running".into(),
            });
        }
        Ok(match method {
            "terminal.send" => json!({"bytes": 6, "entered": false}),
            "worktree.ps" => json!([]),
            _ => json!({}),
        })
    }
    fn now_ms(&self) -> u64 {
        42
    }
    fn record(&mut self, entry: ActivityEntry) {
        self.log.push(entry);
    }
}

fn talk(host: &mut FakeApp, msgs: &[Value]) -> Vec<Value> {
    let input: String = msgs.iter().map(|m| format!("{m}\n")).collect();
    let mut out = Vec::new();
    serve_with(&mut NoDocs, host, input.as_bytes(), &mut out, "1").unwrap();
    String::from_utf8(out)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

fn call(host: &mut FakeApp, name: &str, args: Value) -> Value {
    let r = talk(
        host,
        &[
            json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":args}}),
        ],
    );
    r[0].clone()
}

fn listed(host: &mut FakeApp) -> Vec<String> {
    let r = talk(
        host,
        &[json!({"jsonrpc":"2.0","id":1,"method":"tools/list"})],
    );
    r[0]["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn toggles_decide_the_list_on_every_request() {
    let mut host = FakeApp::default();
    let names = listed(&mut host);
    assert!(names.contains(&"list_tabs".to_owned()));
    assert!(names.contains(&"search_docs".to_owned()));
    assert!(!names.contains(&"send_to_tab".to_owned()));
    host.on.insert("send_to_tab".into(), true);
    host.on.insert("list_tabs".into(), false);
    let names = listed(&mut host);
    assert!(names.contains(&"send_to_tab".to_owned()));
    assert!(!names.contains(&"list_tabs".to_owned()));
}

#[test]
fn a_disabled_tool_cannot_be_called_and_the_app_is_not_asked() {
    let mut host = FakeApp::default();
    let r = call(&mut host, "send_to_tab", json!({"tab": "t1", "text": "hi"}));
    assert_eq!(r["result"]["isError"], true);
    let text = r["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("tool_disabled"), "{text}");
    assert!(host.sent.is_empty());
}

#[test]
fn an_app_that_is_down_is_a_tool_error_not_a_protocol_error() {
    let mut host = FakeApp {
        down: true,
        ..FakeApp::default()
    };
    let r = call(&mut host, "list_worktrees", json!({}));
    assert!(r.get("error").is_none());
    assert_eq!(r["result"]["isError"], true);
    assert!(
        r["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("not running")
    );
}

#[test]
fn calls_are_logged_without_their_arguments() {
    let mut host = FakeApp::default();
    host.on.insert("send_to_tab".into(), true);
    let secret = "hunter2-secret-text";
    let r = call(
        &mut host,
        "send_to_tab",
        json!({"tab": "t1", "text": secret}),
    );
    assert_eq!(r["result"]["isError"], false);
    assert!(
        !r["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains(secret)
    );
    call(&mut host, "list_worktrees", json!({}));
    call(&mut host, "send_to_tab", json!({"tab": "t1"})); // bad arguments
    call(&mut host, "no_such_tool", json!({}));
    let tools: Vec<(&str, bool)> = host.log.iter().map(|e| (e.tool.as_str(), e.ok)).collect();
    assert_eq!(
        tools,
        [
            ("send_to_tab", true),
            ("list_worktrees", true),
            ("send_to_tab", false)
        ]
    );
    assert_eq!(host.log[0].at_ms, 42);
    let dump = serde_json::to_string(&host.log).unwrap();
    assert!(!dump.contains(secret) && !dump.contains("t1"));
}

#[test]
fn the_plain_serve_has_no_app_tools() {
    let mut out = Vec::new();
    let msg = format!(
        "{}\n",
        json!({"jsonrpc":"2.0","id":1,"method":"tools/list"})
    );
    xdev_mcp::serve(&mut NoDocs, msg.as_bytes(), &mut out, "1").unwrap();
    let v: Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["result"]["tools"].as_array().unwrap().len(), 6);
}
