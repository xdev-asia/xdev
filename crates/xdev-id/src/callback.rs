//! The `xdev://auth/callback?…` link, from the OS deep link or a paste.
//!
//! Any local process can start the app with such a link, so the parser is strict and the
//! caller still checks `state` against the one pending attempt.

use url::Url;

use crate::E_LINK;
use crate::pkce::Secret;

const MAX_LEN: usize = 2048;

#[derive(Debug, PartialEq, Eq)]
pub enum Callback {
    Code {
        code: Secret,
        state: Secret,
    },
    /// `error=access_denied`: the person declined in the browser.
    Denied {
        state: Secret,
    },
}

fn token_ok(s: &str) -> bool {
    s.len() == 43
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn parse_callback(raw: &str) -> Result<Callback, &'static str> {
    let raw = raw.trim();
    if raw.len() > MAX_LEN {
        return Err(E_LINK);
    }
    let url = Url::parse(raw).map_err(|_| E_LINK)?;
    if url.scheme() != "xdev"
        || url.host_str() != Some("auth")
        || url.path() != "/callback"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return Err(E_LINK);
    }
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for (key, value) in url.query_pairs() {
        let slot = match key.as_ref() {
            "code" => &mut code,
            "state" => &mut state,
            "error" => &mut error,
            _ => continue,
        };
        if slot.replace(value.into_owned()).is_some() {
            return Err(E_LINK);
        }
    }
    let state = state.filter(|s| token_ok(s)).ok_or(E_LINK)?;
    match (code, error) {
        (Some(code), None) if token_ok(&code) => Ok(Callback::Code {
            code: Secret::new(code),
            state: Secret::new(state),
        }),
        (None, Some(error)) if error == "access_denied" => Ok(Callback::Denied {
            state: Secret::new(state),
        }),
        _ => Err(E_LINK),
    }
}

/// Constant time over equal lengths.
pub fn same_state(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes()
        .zip(b.bytes())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    const CODE: &str = "c0dec0dec0dec0dec0dec0dec0dec0dec0dec0dec0d";
    const STATE: &str = "st4test4test4test4test4test4test4test4test4";

    fn link(query: &str) -> String {
        format!("xdev://auth/callback?{query}")
    }

    fn good() -> String {
        link(&format!("code={CODE}&state={STATE}"))
    }

    fn is_code(r: Result<Callback, &'static str>) -> bool {
        matches!(&r, Ok(Callback::Code { code, state })
            if code.expose() == CODE && state.expose() == STATE)
    }

    #[test]
    fn fixtures_have_43_characters() {
        assert_eq!(CODE.len(), 43);
        assert_eq!(STATE.len(), 43);
    }

    #[test]
    fn accepts_valid_links() {
        assert!(is_code(parse_callback(&good())));
        assert!(is_code(parse_callback(&format!("  \n{}\r\n", good()))));
        assert!(is_code(parse_callback(&good().replacen("xdev", "XDEV", 1))));
        assert!(is_code(parse_callback(&link(&format!(
            "code={CODE}&state={STATE}&extra=1"
        )))));
        assert!(is_code(parse_callback(&link(&format!(
            "state={STATE}&code={CODE}"
        )))));
    }

    #[test]
    fn rejects_wrong_shape() {
        let q = format!("code={CODE}&state={STATE}");
        for bad in [
            format!("xdev://auth/callback/?{q}"),
            format!("https://auth/callback?{q}"),
            format!("xdev://evil/callback?{q}"),
            format!("xdev://auth/cb?{q}"),
            format!("xdev://u@auth/callback?{q}"),
            format!("xdev://u:p@auth/callback?{q}"),
            format!("xdev://auth:1/callback?{q}"),
            format!("xdev://auth/callback?{q}#frag"),
            "xdev://auth/callback".to_owned(),
            "not a link".to_owned(),
            String::new(),
        ] {
            assert_eq!(parse_callback(&bad).err(), Some(E_LINK), "{bad}");
        }
    }

    #[test]
    fn rejects_missing_duplicate_and_malformed_params() {
        let long = "a".repeat(44);
        for bad in [
            link(&format!("state={STATE}")),
            link(&format!("code={CODE}")),
            link(&format!("code={CODE}&code={CODE}&state={STATE}")),
            link(&format!("code={CODE}&state={STATE}&state={STATE}")),
            link(&format!("code={}&state={STATE}", &CODE[..42])),
            link(&format!("code={CODE}a&state={STATE}")),
            link(&format!("code={}%2B&state={STATE}", &CODE[..42])),
            link(&format!("code={}%2F&state={STATE}", &CODE[..42])),
            link(&format!("code={}%3D&state={STATE}", &CODE[..42])),
            link(&format!("code={CODE}&state={long}")),
            link(&format!("code={CODE}&state={}", &STATE[..42])),
            link(&format!(
                "code={CODE}&state={STATE}&pad={}",
                "x".repeat(2048)
            )),
            link(&format!("error=other&state={STATE}")),
            link(&format!("code={CODE}&error=access_denied&state={STATE}")),
        ] {
            assert_eq!(parse_callback(&bad).err(), Some(E_LINK), "{bad}");
        }
    }

    #[test]
    fn parses_access_denied() {
        let r = parse_callback(&link(&format!("error=access_denied&state={STATE}")));
        assert!(matches!(&r, Ok(Callback::Denied { state }) if state.expose() == STATE));
    }

    #[test]
    fn same_state_compares_whole_strings() {
        assert!(same_state(STATE, STATE));
        assert!(!same_state(STATE, CODE));
        assert!(!same_state(STATE, &STATE[..42]));
        assert!(!same_state("", STATE));
        assert!(same_state("", ""));
    }
}
