//! Jira Cloud (REST v3, Basic auth) and self-hosted (REST v2, personal access token). Read-only.

use serde_json::Value;
use url::Url;

use crate::http::{Auth, HttpRequest, HttpSend, Method, Secret, status_error};
use crate::urls::{jira_browse_url, jira_time, same_origin};
use crate::{
    ITEMS_MAX, JiraMode, PAGE_SIZE, PAGES_MAX, TaskSource, TrackerError, TrackerItem, TrackerList,
    TrackerPulls, TrackerStateKind,
};

const FIELDS: &str = "summary,status,assignee,updated";
const TITLE_MAX: usize = 300;
const STATE_MAX: usize = 60;
const ASSIGNEE_MAX: usize = 120;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JiraConn {
    pub mode: JiraMode,
    pub base: String,
    /// Cloud only: the Basic-auth user.
    pub email: Option<String>,
}

fn auth(c: &JiraConn, token: &Secret) -> Result<Auth, TrackerError> {
    match c.mode {
        JiraMode::Cloud => Ok(Auth::Basic {
            user: c
                .email
                .clone()
                .filter(|e| !e.is_empty())
                .ok_or(TrackerError::NotConfigured)?,
            secret: token.clone(),
        }),
        JiraMode::Server => Ok(Auth::Bearer(token.clone())),
    }
}

fn api(c: &JiraConn) -> &'static str {
    match c.mode {
        JiraMode::Cloud => "rest/api/3",
        JiraMode::Server => "rest/api/2",
    }
}

fn get(c: &JiraConn, token: &Secret, url: String) -> Result<HttpRequest, TrackerError> {
    // The token goes only to the configured base.
    if !same_origin(&c.base, &url) {
        return Err(TrackerError::BadUrl);
    }
    Ok(HttpRequest {
        method: Method::Get,
        url,
        auth: auth(c, token)?,
        json: None,
    })
}

fn send_json(h: &dyn HttpSend, req: &HttpRequest) -> Result<Value, TrackerError> {
    let res = h.send(req).map_err(|_| TrackerError::Offline)?;
    status_error(&res, TrackerError::NotFound)?;
    serde_json::from_slice(&res.body).map_err(|_| TrackerError::BadReply)
}

/// The display name of the signed-in account; proves the credentials work.
pub fn jira_myself(h: &dyn HttpSend, c: &JiraConn, token: &Secret) -> Result<String, TrackerError> {
    let req = get(c, token, format!("{}/{}/myself", c.base, api(c)))?;
    let body = send_json(h, &req)?;
    body.get("displayName")
        .or_else(|| body.get("name"))
        .and_then(Value::as_str)
        .map(|s| s.chars().take(ASSIGNEE_MAX).collect::<String>())
        .filter(|s| !s.is_empty())
        .ok_or(TrackerError::BadReply)
}

pub fn jira_jql(pulls: &TrackerPulls) -> String {
    let p = pulls.normalized();
    let who = match (p.assigned, p.created) {
        (true, true) => "(assignee = currentUser() OR reporter = currentUser())",
        (true, false) => "assignee = currentUser()",
        _ => "reporter = currentUser()",
    };
    let scope = if p.done {
        "(statusCategory != Done OR updated >= -30d)"
    } else {
        "statusCategory != Done"
    };
    format!("{who} AND {scope} ORDER BY updated DESC")
}

fn kind_of(category: &str) -> TrackerStateKind {
    match category {
        "indeterminate" => TrackerStateKind::InProgress,
        "done" => TrackerStateKind::Done,
        _ => TrackerStateKind::Todo,
    }
}

fn map_issue(base: &str, node: &Value) -> Option<TrackerItem> {
    let id = node
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())?;
    let key = node.get("key").and_then(Value::as_str)?;
    let url = jira_browse_url(base, key)?;
    let f = node.get("fields")?;
    let title = f
        .get("summary")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())?;
    let state = f
        .pointer("/status/name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let category = f
        .pointer("/status/statusCategory/key")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let assignee = f
        .pointer("/assignee/displayName")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(ASSIGNEE_MAX).collect());
    Some(TrackerItem {
        source: TaskSource::Jira,
        id: id.to_owned(),
        key: key.to_owned(),
        title: title.chars().take(TITLE_MAX).collect(),
        state: state.chars().take(STATE_MAX).collect(),
        state_kind: kind_of(category),
        assignee,
        url,
        updated_at: jira_time(f.get("updated").and_then(Value::as_str).unwrap_or_default()),
    })
}

fn search_url(c: &JiraConn, params: &[(&str, String)]) -> Result<String, TrackerError> {
    let path = match c.mode {
        JiraMode::Cloud => "search/jql",
        JiraMode::Server => "search",
    };
    let raw = format!("{}/{}/{}", c.base, api(c), path);
    Url::parse_with_params(&raw, params)
        .map(|u| u.to_string())
        .map_err(|_| TrackerError::BadUrl)
}

/// Up to `PAGES_MAX` pages of `PAGE_SIZE`, at most `ITEMS_MAX` rows, newest update first.
pub fn jira_list(
    h: &dyn HttpSend,
    c: &JiraConn,
    token: &Secret,
    pulls: &TrackerPulls,
) -> Result<TrackerList, TrackerError> {
    let jql = jira_jql(pulls);
    let mut items: Vec<TrackerItem> = Vec::new();
    let mut more = false;
    let mut next_token: Option<String> = None;
    let mut start_at: usize = 0;
    for _ in 0..PAGES_MAX {
        let mut params = vec![
            ("jql", jql.clone()),
            ("fields", FIELDS.to_owned()),
            ("maxResults", PAGE_SIZE.to_string()),
        ];
        match c.mode {
            JiraMode::Cloud => {
                if let Some(t) = &next_token {
                    params.push(("nextPageToken", t.clone()));
                }
            }
            JiraMode::Server => params.push(("startAt", start_at.to_string())),
        }
        let req = get(c, token, search_url(c, &params)?)?;
        let body = send_json(h, &req)?;
        let issues = body
            .get("issues")
            .and_then(Value::as_array)
            .ok_or(TrackerError::BadReply)?;
        items.extend(issues.iter().filter_map(|n| map_issue(&c.base, n)));
        match c.mode {
            JiraMode::Cloud => {
                next_token = body
                    .get("nextPageToken")
                    .and_then(Value::as_str)
                    .filter(|t| !t.is_empty())
                    .map(str::to_owned);
                let last = body.get("isLast").and_then(Value::as_bool).unwrap_or(false);
                more = !last && next_token.is_some();
            }
            JiraMode::Server => {
                start_at += issues.len();
                let total = body.get("total").and_then(Value::as_u64).unwrap_or(0) as usize;
                more = !issues.is_empty() && start_at < total;
            }
        }
        if !more {
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

    const MYSELF: &str = include_str!("../tests/fixtures/jira_myself.json");
    const CLOUD_P1: &str = include_str!("../tests/fixtures/jira_cloud_search_p1.json");
    const CLOUD_LAST: &str = include_str!("../tests/fixtures/jira_cloud_search_last.json");
    const SERVER: &str = include_str!("../tests/fixtures/jira_server_search.json");

    fn cloud() -> JiraConn {
        JiraConn {
            mode: JiraMode::Cloud,
            base: "https://acme.atlassian.net".into(),
            email: Some("a@x.io".into()),
        }
    }

    fn server() -> JiraConn {
        JiraConn {
            mode: JiraMode::Server,
            base: "https://jira.corp.example/jira".into(),
            email: None,
        }
    }

    fn tok() -> Secret {
        Secret::new("jira-SENTINEL")
    }

    fn pulls(assigned: bool, created: bool, done: bool) -> TrackerPulls {
        TrackerPulls {
            assigned,
            created,
            done,
        }
    }

    fn query_of(url: &str) -> std::collections::BTreeMap<String, String> {
        Url::parse(url)
            .unwrap()
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect()
    }

    #[test]
    fn jql_snapshots() {
        assert_eq!(
            jira_jql(&pulls(true, false, false)),
            "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC"
        );
        assert_eq!(
            jira_jql(&pulls(false, true, false)),
            "reporter = currentUser() AND statusCategory != Done ORDER BY updated DESC"
        );
        assert_eq!(
            jira_jql(&pulls(true, true, false)),
            "(assignee = currentUser() OR reporter = currentUser()) AND statusCategory != Done ORDER BY updated DESC"
        );
        assert_eq!(
            jira_jql(&pulls(true, false, true)),
            "assignee = currentUser() AND (statusCategory != Done OR updated >= -30d) ORDER BY updated DESC"
        );
    }

    #[test]
    fn myself_cloud_and_server() {
        let f = FakeHttp::new();
        f.push(200, MYSELF);
        assert_eq!(jira_myself(&f, &cloud(), &tok()).unwrap(), "Ada");
        let r = &f.requests()[0];
        assert_eq!(r.method, Method::Get);
        assert_eq!(r.url, "https://acme.atlassian.net/rest/api/3/myself");
        assert_eq!(
            r.auth,
            Auth::Basic {
                user: "a@x.io".into(),
                secret: tok()
            }
        );

        let f = FakeHttp::new();
        f.push(200, MYSELF);
        assert_eq!(jira_myself(&f, &server(), &tok()).unwrap(), "Ada");
        let r = &f.requests()[0];
        assert_eq!(r.url, "https://jira.corp.example/jira/rest/api/2/myself");
        assert_eq!(r.auth, Auth::Bearer(tok()));
    }

    #[test]
    fn cloud_list_pages_by_token() {
        let f = FakeHttp::new();
        f.push(200, CLOUD_P1).push(200, CLOUD_LAST);
        let list = jira_list(&f, &cloud(), &tok(), &pulls(true, false, true)).unwrap();
        let reqs = f.requests();
        assert_eq!(reqs.len(), 2);
        let q1 = query_of(&reqs[0].url);
        assert_eq!(q1["jql"], jira_jql(&pulls(true, false, true)));
        assert_eq!(q1["fields"], "summary,status,assignee,updated");
        assert_eq!(q1["maxResults"], "50");
        assert!(!q1.contains_key("nextPageToken"));
        assert!(
            reqs[0]
                .url
                .starts_with("https://acme.atlassian.net/rest/api/3/search/jql?")
        );
        // Spaces and symbols are encoded in the raw URL.
        assert!(!reqs[0].url.contains(' ') && !reqs[0].url.contains('('));
        assert_eq!(query_of(&reqs[1].url)["nextPageToken"], "page-2-token");
        assert!(!list.truncated);

        // PROJ-7 newest, then PROJ-3, then PROJ-1; "bad-key" dropped.
        let keys: Vec<&str> = list.items.iter().map(|i| i.key.as_str()).collect();
        assert_eq!(keys, ["PROJ-7", "PROJ-3", "PROJ-1"]);
        let by = |k: &str| list.items.iter().find(|i| i.key == k).unwrap();
        assert_eq!(by("PROJ-3").state_kind, TrackerStateKind::InProgress);
        assert_eq!(by("PROJ-3").state, "In Progress");
        assert_eq!(by("PROJ-3").assignee.as_deref(), Some("Ada"));
        assert_eq!(by("PROJ-3").updated_at, "2026-11-05T10:12:00.000+07:00");
        assert_eq!(by("PROJ-3").url, "https://acme.atlassian.net/browse/PROJ-3");
        assert_eq!(by("PROJ-1").state_kind, TrackerStateKind::Todo);
        assert_eq!(by("PROJ-1").assignee, None);
        assert_eq!(by("PROJ-7").state_kind, TrackerStateKind::Done);
        assert_eq!(by("PROJ-7").source, TaskSource::Jira);
        for r in &reqs {
            assert!(same_origin(&cloud().base, &r.url));
        }
    }

    #[test]
    fn server_list_pages_by_start_at() {
        let f = FakeHttp::new();
        f.push(200, SERVER);
        let list = jira_list(&f, &server(), &tok(), &TrackerPulls::default()).unwrap();
        assert_eq!(f.requests().len(), 1);
        let q = query_of(&f.requests()[0].url);
        assert_eq!(q["startAt"], "0");
        assert!(
            f.requests()[0]
                .url
                .starts_with("https://jira.corp.example/jira/rest/api/2/search?")
        );
        assert_eq!(list.items.len(), 2);
        assert!(!list.truncated);
        assert_eq!(list.items[0].key, "OPS-5");
        assert_eq!(list.items[0].updated_at, "2026-11-04T10:00:00.000+00:00");
    }

    fn server_page(start: usize, count: usize, total: usize) -> String {
        let issues: Vec<String> = (start..start + count)
            .map(|n| {
                format!(
                    r#"{{"id":"{n}","key":"OPS-{n}","fields":{{"summary":"t","status":{{"name":"Open","statusCategory":{{"key":"new"}}}},"assignee":null,"updated":"2026-11-04T10:00:00.000+0000"}}}}"#
                )
            })
            .collect();
        format!(
            r#"{{"startAt":{start},"total":{total},"issues":[{}]}}"#,
            issues.join(",")
        )
    }

    #[test]
    fn server_list_second_page_and_cap() {
        let f = FakeHttp::new();
        f.push(200, &server_page(0, 50, 80))
            .push(200, &server_page(50, 30, 80));
        let list = jira_list(&f, &server(), &tok(), &TrackerPulls::default()).unwrap();
        assert_eq!(f.requests().len(), 2);
        assert_eq!(query_of(&f.requests()[1].url)["startAt"], "50");
        assert_eq!(list.items.len(), 80);

        let f = FakeHttp::new();
        for p in 0..5 {
            f.push(200, &server_page(p * 50, 50, 1000));
        }
        let list = jira_list(&f, &server(), &tok(), &TrackerPulls::default()).unwrap();
        assert_eq!(f.requests().len(), 4);
        assert_eq!(list.items.len(), ITEMS_MAX);
        assert!(list.truncated);
    }

    fn err_of(f: &FakeHttp) -> TrackerError {
        jira_list(f, &cloud(), &tok(), &TrackerPulls::default()).unwrap_err()
    }

    #[test]
    fn reply_errors() {
        for (status, want) in [
            (401, TrackerError::Auth),
            (403, TrackerError::Auth),
            (404, TrackerError::NotFound),
            (301, TrackerError::Redirected),
            (503, TrackerError::Unavailable),
        ] {
            let f = FakeHttp::new();
            f.push(status, "");
            assert_eq!(err_of(&f), want, "{status}");
        }
        let f = FakeHttp::new();
        f.push_retry(429, 30, "");
        assert_eq!(err_of(&f), TrackerError::RateLimited(Some(30)));
        let f = FakeHttp::new();
        f.push(200, "{bad");
        assert_eq!(err_of(&f), TrackerError::BadReply);
        let f = FakeHttp::new();
        f.push_offline();
        assert_eq!(err_of(&f), TrackerError::Offline);
    }

    #[test]
    fn a_url_off_the_base_is_never_sent() {
        let c = cloud();
        assert_eq!(
            get(&c, &tok(), "https://evil.example/x".into()).err(),
            Some(TrackerError::BadUrl)
        );
    }
}
