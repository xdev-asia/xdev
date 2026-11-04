//! Which xDev ID server the app talks to: `XDEV_ID_URL`, then the `xdevId.server`
//! setting, then the default. Every candidate passes `check_origin`, so a token can only go
//! to https or a loopback http origin with no path, query, fragment or user info.

use serde::Serialize;

use crate::DEFAULT_BASE;
use crate::link::check_origin;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ServerSource {
    Env,
    Setting,
    Default,
}

/// What the Settings page shows: the server in use and where it came from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct XdevIdServer {
    /// The origin in use, with no trailing slash.
    pub origin: String,
    pub source: ServerSource,
    /// The setting as stored (empty when unset), for the text field.
    pub setting: String,
    /// The setting holds a value that is not a valid server, and was ignored.
    pub invalid: bool,
}

/// Env first, then the setting, then the default. An unusable env value is ignored, so a
/// bad variable never hides a good setting. An empty setting is "unset"; a non-empty one
/// that fails the check is ignored and flagged.
pub fn resolve_server(env: Option<&str>, setting: Option<&str>) -> XdevIdServer {
    let setting = setting.unwrap_or("").trim();
    let from_setting = if setting.is_empty() {
        None
    } else {
        check_origin(setting)
    };
    let invalid = !setting.is_empty() && from_setting.is_none();
    let (origin, source) = if let Some(origin) = env.and_then(check_origin) {
        (origin, ServerSource::Env)
    } else if let Some(origin) = from_setting {
        (origin, ServerSource::Setting)
    } else {
        (DEFAULT_BASE.to_owned(), ServerSource::Default)
    };
    XdevIdServer {
        origin,
        source,
        setting: setting.to_owned(),
        invalid,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pick(env: Option<&str>, setting: Option<&str>) -> (String, ServerSource, bool) {
        let s = resolve_server(env, setting);
        (s.origin, s.source, s.invalid)
    }

    #[test]
    fn precedence_is_env_then_setting_then_default() {
        let d = DEFAULT_BASE.to_owned();
        assert_eq!(pick(None, None), (d.clone(), ServerSource::Default, false));
        assert_eq!(
            pick(None, Some("")),
            (d.clone(), ServerSource::Default, false)
        );
        assert_eq!(pick(None, Some("  ")), (d, ServerSource::Default, false));
        assert_eq!(
            pick(None, Some("https://id.corp.test")),
            ("https://id.corp.test".into(), ServerSource::Setting, false)
        );
        assert_eq!(
            pick(Some("https://env.test"), Some("https://id.corp.test")),
            ("https://env.test".into(), ServerSource::Env, false)
        );
        // An unusable env value falls through to the setting.
        assert_eq!(
            pick(Some("http://evil.test"), Some("https://id.corp.test/")),
            ("https://id.corp.test".into(), ServerSource::Setting, false)
        );
    }

    #[test]
    fn a_setting_follows_the_same_rules_as_the_env_variable() {
        for ok in [
            "https://x.test",
            "http://localhost:8787",
            "http://127.0.0.1:1/",
        ] {
            assert!(!resolve_server(None, Some(ok)).invalid, "{ok}");
        }
        for bad in [
            "http://id.corp.test",
            "ftp://x.test",
            "not a url",
            "https://u:p@x.test",
            "https://x.test/path",
            "https://x.test/?q=1",
            "https://x.test/#f",
            "http://127.0.0.1.evil.test",
        ] {
            let s = resolve_server(None, Some(bad));
            assert_eq!(
                (s.origin.as_str(), s.source, s.invalid),
                (DEFAULT_BASE, ServerSource::Default, true),
                "{bad}"
            );
            assert_eq!(s.setting, bad);
        }
        // The text field keeps what is stored, trimmed.
        assert_eq!(
            resolve_server(None, Some(" https://x.test ")).setting,
            "https://x.test"
        );
    }

    #[test]
    fn an_invalid_setting_still_reports_when_env_wins() {
        let s = resolve_server(Some("https://env.test"), Some("nope"));
        assert_eq!((s.source, s.invalid), (ServerSource::Env, true));
    }

    #[test]
    fn serialises_camel_case() {
        let json = serde_json::to_string(&resolve_server(None, None)).unwrap();
        assert_eq!(
            json,
            r#"{"origin":"https://id.xdev.asia","source":"default","setting":"","invalid":false}"#
        );
    }
}
