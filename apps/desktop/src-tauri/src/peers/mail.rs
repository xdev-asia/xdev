//! A hand-off to a tab on another computer: `to` is `<computer>/<tab>`.

use serde_json::{Value, json};
use xdev_link::RpcError;

use super::{ACTION_WAIT, Core};

/// Where a hand-off's `to` points.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Route {
    /// A tab on paired computer `peer_id`.
    Peer { peer_id: String, tab: String },
    /// A tab here.
    Local,
}

/// `A-laptop/review` goes to the paired computer `A-laptop` when `resolve`
/// knows it; anything else stays here.
pub(crate) fn route(to: &str, resolve: impl Fn(&str) -> Option<String>) -> Route {
    let Some((computer, tab)) = to.split_once('/') else {
        return Route::Local;
    };
    let tab = tab.trim();
    if computer.trim().is_empty() || tab.is_empty() {
        return Route::Local;
    }
    match resolve(computer) {
        Some(peer_id) => Route::Peer {
            peer_id,
            tab: tab.to_owned(),
        },
        None => Route::Local,
    }
}

/// Sends a hand-off to `tab` on `peer_id`. The answer is the other side's
/// message with `to` rewritten to `peer:<id>/<tab>`.
pub(crate) fn send(
    core: &Core,
    peer_id: &str,
    tab: &str,
    from_title: &str,
    body: &str,
) -> Result<Value, RpcError> {
    let mut v = core.call(
        peer_id,
        "mail.handoff",
        json!({ "to_tab": tab, "from_title": from_title, "body": body }),
        ACTION_WAIT,
    )?;
    let to = format!("peer:{peer_id}/{tab}");
    match v.as_object_mut() {
        Some(o) => {
            o.insert("to".into(), json!(to));
        }
        None => v = json!({ "to": to }),
    }
    Ok(v)
}
