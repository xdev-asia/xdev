//! Linear's GraphQL API: the viewer check and the issue list. Read-only.

use serde_json::{Value, json};

use crate::http::{Auth, HttpRequest, HttpResponse, HttpSend, Method, Secret, status_error};
use crate::{
    ITEMS_MAX, LINEAR_ENDPOINT, PAGES_MAX, TaskSource, TrackerError, TrackerItem, TrackerList,
    TrackerPulls, TrackerStateKind,
};

const VIEWER_QUERY: &str = "query { viewer { id name } }";

const ISSUES_QUERY: &str = "query Issues($filter: IssueFilter, $after: String) { \
issues(first: 50, after: $after, filter: $filter, orderBy: updatedAt) { \
nodes { id identifier title url updatedAt state { name type } assignee { name } } \
pageInfo { hasNextPage endCursor } } }";

const TITLE_MAX: usize = 300;
const STATE_MAX: usize = 60;
const ASSIGNEE_MAX: usize = 120;

/// The `$filter` variable. `since` is an RFC 3339 time; it is used only with `done`.
pub fn linear_filter(pulls: &TrackerPulls, since: &str) -> Value {
    let p = pulls.normalized();
    let mut who = Vec::new();
    if p.assigned {
        who.push(json!({ "assignee": { "isMe": { "eq": true } } }));
    }
    if p.created {
        who.push(json!({ "creator": { "isMe": { "eq": true } } }));
    }
    let open = json!({ "state": { "type": { "nin": ["completed", "canceled"] } } });
    let scope = if p.done {
        let recent = json!({ "and": [
            { "state": { "type": { "eq": "completed" } } },
            { "completedAt": { "gt": since } }
        ] });
        json!({ "or": [open, recent] })
    } else {
        open
    };
    json!({ "and": [ { "or": who }, scope ] })
}

fn post(key: &Secret, query: &str, variables: Value) -> HttpRequest {
    HttpRequest {
        method: Method::Post,
        url: LINEAR_ENDPOINT.to_owned(),
        auth: Auth::Raw(key.clone()),
        json: Some(json!({ "query": query, "variables": variables }).to_string()),
    }
}

/// GraphQL error codes in a reply, if any.
fn graphql_error(body: &Value) -> Option<TrackerError> {
    let errors = body.get("errors")?.as_array()?;
    if errors.is_empty() {
        return None;
    }
    for e in errors {
        match e
            .pointer("/extensions/code")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "AUTHENTICATION_ERROR" => return Some(TrackerError::Auth),
            "RATELIMITED" => return Some(TrackerError::RateLimited(None)),
            _ => {}
        }
    }
    Some(TrackerError::BadReply)
}

fn call(h: &dyn HttpSend, req: &HttpRequest) -> Result<Value, TrackerError> {
    let res: HttpResponse = h.send(req).map_err(|_| TrackerError::Offline)?;
    // Linear may answer 400 with a GraphQL error body: read that before the status.
    if res.status == 400
        && let Ok(body) = serde_json::from_slice::<Value>(&res.body)
        && let Some(e) = graphql_error(&body)
    {
        return Err(e);
    }
    status_error(&res, TrackerError::Unavailable)?;
    let body: Value = serde_json::from_slice(&res.body).map_err(|_| TrackerError::BadReply)?;
    match graphql_error(&body) {
        Some(e) => Err(e),
        None => Ok(body),
    }
}

/// The account name; proves the key works.
pub fn linear_viewer(h: &dyn HttpSend, key: &Secret) -> Result<String, TrackerError> {
    let body = call(h, &post(key, VIEWER_QUERY, json!({})))?;
    body.pointer("/data/viewer/name")
        .and_then(Value::as_str)
        .map(|s| cut(s, ASSIGNEE_MAX))
        .filter(|s| !s.is_empty())
        .ok_or(TrackerError::BadReply)
}

fn cut(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

fn state_kind(kind: &str) -> TrackerStateKind {
    match kind {
        "started" => TrackerStateKind::InProgress,
        "completed" => TrackerStateKind::Done,
        "canceled" => TrackerStateKind::Canceled,
        _ => TrackerStateKind::Todo,
    }
}

fn linear_url_ok(url: &str) -> bool {
    url::Url::parse(url)
        .ok()
        .is_some_and(|u| u.scheme() == "https" && u.host_str() == Some("linear.app"))
}

fn map_node(node: &Value) -> Option<TrackerItem> {
    let text = |p: &str| {
        node.get(p)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    };
    let id = text("id")?;
    let key = text("identifier")?;
    let title = text("title")?;
    let url = text("url").filter(|u| linear_url_ok(u))?;
    let state = node.pointer("/state/name").and_then(Value::as_str)?;
    let kind = node
        .pointer("/state/type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let assignee = node
        .pointer("/assignee/name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(|s| cut(s, ASSIGNEE_MAX));
    Some(TrackerItem {
        source: TaskSource::Linear,
        id: id.to_owned(),
        key: cut(key, STATE_MAX),
        title: cut(title, TITLE_MAX),
        state: cut(state, STATE_MAX),
        state_kind: state_kind(kind),
        assignee,
        url: url.to_owned(),
        updated_at: text("updatedAt").unwrap_or_default().to_owned(),
    })
}

/// Up to `PAGES_MAX` pages of `PAGE_SIZE`, at most `ITEMS_MAX` rows, newest update first.
pub fn linear_list(
    h: &dyn HttpSend,
    key: &Secret,
    pulls: &TrackerPulls,
    since: &str,
) -> Result<TrackerList, TrackerError> {
    let filter = linear_filter(pulls, since);
    let mut items: Vec<TrackerItem> = Vec::new();
    let mut after: Option<String> = None;
    let mut more = false;
    for _ in 0..PAGES_MAX {
        let vars = json!({ "filter": filter, "after": after });
        let body = call(h, &post(key, ISSUES_QUERY, vars))?;
        let conn = body.pointer("/data/issues").ok_or(TrackerError::BadReply)?;
        let nodes = conn
            .get("nodes")
            .and_then(Value::as_array)
            .ok_or(TrackerError::BadReply)?;
        items.extend(nodes.iter().filter_map(map_node));
        more = conn
            .pointer("/pageInfo/hasNextPage")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        after = conn
            .pointer("/pageInfo/endCursor")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if !more || after.is_none() {
            break;
        }
    }
    let truncated = more || items.len() > ITEMS_MAX;
    items.truncate(ITEMS_MAX);
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(TrackerList { items, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::FakeHttp;

    const VIEWER: &str = include_str!("../tests/fixtures/linear_viewer.json");
    const P1: &str = include_str!("../tests/fixtures/linear_issues_p1.json");
    const P2: &str = include_str!("../tests/fixtures/linear_issues_p2.json");
    const ERR_AUTH: &str = include_str!("../tests/fixtures/linear_err_auth.json");
    const ERR_RATE: &str = include_str!("../tests/fixtures/linear_err_ratelimited.json");

    fn key() -> Secret {
        Secret::new("lin-SENTINEL")
    }

    fn pulls(assigned: bool, created: bool, done: bool) -> TrackerPulls {
        TrackerPulls {
            assigned,
            created,
            done,
        }
    }

    #[test]
    fn viewer_sends_one_post_without_the_token_in_the_body() {
        let fake = FakeHttp::new();
        fake.push(200, VIEWER);
        assert_eq!(linear_viewer(&fake, &key()).unwrap(), "Ada");
        let reqs = fake.requests();
        assert_eq!(reqs.len(), 1);
        assert_eq!(reqs[0].method, Method::Post);
        assert_eq!(reqs[0].url, LINEAR_ENDPOINT);
        assert_eq!(reqs[0].auth, Auth::Raw(key()));
        let body = reqs[0].json.clone().unwrap();
        assert!(body.contains("viewer"));
        assert!(!body.contains("lin-SENTINEL"));
    }

    #[test]
    fn filter_snapshots() {
        let since = "2026-10-08T00:00:00Z";
        assert_eq!(
            linear_filter(&pulls(true, false, false), since).to_string(),
            r#"{"and":[{"or":[{"assignee":{"isMe":{"eq":true}}}]},{"state":{"type":{"nin":["completed","canceled"]}}}]}"#
        );
        assert_eq!(
            linear_filter(&pulls(false, true, false), since).to_string(),
            r#"{"and":[{"or":[{"creator":{"isMe":{"eq":true}}}]},{"state":{"type":{"nin":["completed","canceled"]}}}]}"#
        );
        assert_eq!(
            linear_filter(&pulls(true, true, false), since).to_string(),
            r#"{"and":[{"or":[{"assignee":{"isMe":{"eq":true}}},{"creator":{"isMe":{"eq":true}}}]},{"state":{"type":{"nin":["completed","canceled"]}}}]}"#
        );
        assert_eq!(
            linear_filter(&pulls(true, false, true), since).to_string(),
            r#"{"and":[{"or":[{"assignee":{"isMe":{"eq":true}}}]},{"or":[{"state":{"type":{"nin":["completed","canceled"]}}},{"and":[{"state":{"type":{"eq":"completed"}}},{"completedAt":{"gt":"2026-10-08T00:00:00Z"}}]}]}]}"#
        );
    }

    #[test]
    fn list_two_pages_maps_and_sorts() {
        let fake = FakeHttp::new();
        fake.push(200, P1).push(200, P2);
        let list = linear_list(
            &fake,
            &key(),
            &pulls(true, false, true),
            "2026-10-08T00:00:00Z",
        )
        .unwrap();
        let reqs = fake.requests();
        assert_eq!(reqs.len(), 2);
        let second: Value = serde_json::from_str(reqs[1].json.as_ref().unwrap()).unwrap();
        assert_eq!(second["variables"]["after"], "cursor-1");
        let first: Value = serde_json::from_str(reqs[0].json.as_ref().unwrap()).unwrap();
        assert!(first["variables"]["after"].is_null());
        assert!(!list.truncated);
        // ENG-20 (other host) is dropped.
        let keys: Vec<&str> = list.items.iter().map(|i| i.key.as_str()).collect();
        assert_eq!(keys, ["ENG-15", "ENG-12", "ENG-9", "ENG-21"]);
        let by = |k: &str| list.items.iter().find(|i| i.key == k).unwrap();
        assert_eq!(by("ENG-12").state_kind, TrackerStateKind::InProgress);
        assert_eq!(by("ENG-12").assignee.as_deref(), Some("Ada"));
        assert_eq!(by("ENG-12").state, "In Progress");
        assert_eq!(by("ENG-9").state_kind, TrackerStateKind::Done);
        assert_eq!(by("ENG-9").assignee, None);
        assert_eq!(by("ENG-15").state_kind, TrackerStateKind::Todo);
        assert_eq!(by("ENG-21").state_kind, TrackerStateKind::Canceled);
        assert_eq!(by("ENG-12").source, TaskSource::Linear);
        assert!(fake.requests().iter().all(|r| r.url == LINEAR_ENDPOINT));
    }

    #[test]
    fn long_title_is_cut() {
        let long = "x".repeat(400);
        let page = format!(
            r#"{{"data":{{"issues":{{"nodes":[{{"id":"a","identifier":"ENG-1","title":"{long}","url":"https://linear.app/e/issue/ENG-1","updatedAt":"2026-11-05T10:00:00Z","state":{{"name":"Todo","type":"unstarted"}},"assignee":null}}],"pageInfo":{{"hasNextPage":false,"endCursor":null}}}}}}}}"#
        );
        let fake = FakeHttp::new();
        fake.push(200, &page);
        let list = linear_list(&fake, &key(), &TrackerPulls::default(), "s").unwrap();
        assert_eq!(list.items[0].title.chars().count(), 300);
    }

    fn full_page(start: usize, count: usize, has_next: bool) -> String {
        let nodes: Vec<String> = (start..start + count)
            .map(|n| {
                format!(
                    r#"{{"id":"i{n}","identifier":"ENG-{n}","title":"t{n}","url":"https://linear.app/e/issue/ENG-{n}","updatedAt":"2026-11-05T10:00:{:02}Z","state":{{"name":"Todo","type":"unstarted"}},"assignee":null}}"#,
                    n % 60
                )
            })
            .collect();
        format!(
            r#"{{"data":{{"issues":{{"nodes":[{}],"pageInfo":{{"hasNextPage":{has_next},"endCursor":"c{start}"}}}}}}}}"#,
            nodes.join(",")
        )
    }

    #[test]
    fn four_full_pages_stop_at_the_cap() {
        let fake = FakeHttp::new();
        for p in 0..5 {
            fake.push(200, &full_page(p * 50, 50, true));
        }
        let list = linear_list(&fake, &key(), &TrackerPulls::default(), "s").unwrap();
        assert_eq!(fake.requests().len(), 4);
        assert_eq!(list.items.len(), ITEMS_MAX);
        assert!(list.truncated);
    }

    fn err_of(fake: &FakeHttp) -> TrackerError {
        linear_list(fake, &key(), &TrackerPulls::default(), "s").unwrap_err()
    }

    #[test]
    fn reply_errors() {
        let f = FakeHttp::new();
        f.push(401, "");
        assert_eq!(err_of(&f), TrackerError::Auth);
        let f = FakeHttp::new();
        f.push(200, ERR_AUTH);
        assert_eq!(err_of(&f), TrackerError::Auth);
        let f = FakeHttp::new();
        f.push(200, ERR_RATE);
        assert_eq!(err_of(&f), TrackerError::RateLimited(None));
        let f = FakeHttp::new();
        f.push_retry(429, 60, "");
        assert_eq!(err_of(&f), TrackerError::RateLimited(Some(60)));
        let f = FakeHttp::new();
        f.push(500, "");
        assert_eq!(err_of(&f), TrackerError::Unavailable);
        let f = FakeHttp::new();
        f.push(302, "");
        assert_eq!(err_of(&f), TrackerError::Redirected);
        let f = FakeHttp::new();
        f.push(200, "not json");
        assert_eq!(err_of(&f), TrackerError::BadReply);
        let f = FakeHttp::new();
        f.push_offline();
        assert_eq!(err_of(&f), TrackerError::Offline);
        let f = FakeHttp::new();
        f.push(200, r#"{"errors":[{"message":"x"}]}"#);
        assert_eq!(err_of(&f), TrackerError::BadReply);
    }

    #[test]
    fn oversized_body_is_a_bad_reply() {
        let f = FakeHttp::new();
        f.push_full(200, None, vec![b' '; crate::BODY_MAX + 1]);
        assert_eq!(err_of(&f), TrackerError::BadReply);
    }
}
