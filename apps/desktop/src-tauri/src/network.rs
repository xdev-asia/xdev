//! Settings → Advanced: proxy validation, the env a new terminal gets, the
//! updater's HTTP client config and the machine name. The builders are pure
//! so tests need no network and no process env.

use std::ffi::OsString;

use crate::applog;
use crate::settings::NetworkSettings;

const MAX_NO_PROXY: usize = 100;
const MAX_PATTERN: usize = 253;
const MAX_NAME: usize = 64;

/// Why a proxy or mirror URL was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UrlError {
    Unparsable,
    Scheme,
    NoHost,
}

impl std::fmt::Display for UrlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            UrlError::Unparsable => "not a URL",
            UrlError::Scheme => "the scheme is not allowed",
            UrlError::NoHost => "no host",
        })
    }
}

fn parse_with(raw: &str, schemes: &[&str]) -> Result<tauri::Url, UrlError> {
    let raw = raw.trim();
    if raw.chars().any(char::is_whitespace) {
        return Err(UrlError::Unparsable);
    }
    let url = tauri::Url::parse(raw).map_err(|_| UrlError::Unparsable)?;
    if !schemes.contains(&url.scheme()) {
        return Err(UrlError::Scheme);
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(UrlError::NoHost);
    }
    Ok(url)
}

/// An empty proxy is valid (none). Otherwise `http`, `https`, `socks5` or
/// `socks5h` with a host.
pub(crate) fn validate_proxy(raw: &str) -> Result<(), UrlError> {
    if raw.trim().is_empty() {
        return Ok(());
    }
    parse_with(raw, &["http", "https", "socks5", "socks5h"]).map(drop)
}

/// An empty mirror is valid (none). Otherwise an `http` or `https` URL.
pub(crate) fn validate_mirror(raw: &str) -> Result<(), UrlError> {
    if raw.trim().is_empty() {
        return Ok(());
    }
    parse_with(raw, &["http", "https"]).map(drop)
}

/// Trims, splits on commas, drops empty and repeated entries, caps count and length.
pub(crate) fn clean_no_proxy(raw: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for item in raw.iter().flat_map(|l| l.split(',')) {
        let item = item.trim();
        if item.is_empty()
            || item.len() > MAX_PATTERN
            || item.chars().any(|c| c.is_whitespace() || c.is_control())
            || out.iter().any(|o| o.eq_ignore_ascii_case(item))
        {
            continue;
        }
        out.push(item.to_owned());
        if out.len() == MAX_NO_PROXY {
            break;
        }
    }
    out
}

/// Trimmed, without control characters, at most 64 characters.
pub(crate) fn clean_machine_name(raw: &str) -> String {
    raw.chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .chars()
        .take(MAX_NAME)
        .collect()
}

/// The put's check: the field name that does not validate.
pub(crate) fn invalid_field(s: &NetworkSettings) -> Option<&'static str> {
    if validate_proxy(&s.proxy_url).is_err() {
        Some("proxyUrl")
    } else if validate_mirror(&s.node_mirror).is_err() {
        Some("nodeMirror")
    } else {
        None
    }
}

/// The proxy variables, the bypass list and the registry for a new terminal.
/// `is_set(name)` says whether the user's own environment already has `name`;
/// such a variable is left alone. An invalid proxy or mirror adds nothing.
pub(crate) fn terminal_env(
    s: &NetworkSettings,
    is_set: &dyn Fn(&str) -> bool,
) -> Vec<(String, OsString)> {
    terminal_env_with_project(s, &[], is_set)
}

/// `terminal_env` plus a project's variables (`xdev_workspace::merge_env`).
/// A project variable overrides what the terminal inherits, so it ignores
/// `is_set`, except an `XDEV_*` name, which is the app's own and is dropped.
/// The network variables then treat a project name as already set.
pub(crate) fn terminal_env_with_project(
    s: &NetworkSettings,
    project: &[(String, String)],
    is_set: &dyn Fn(&str) -> bool,
) -> Vec<(String, OsString)> {
    let same = |a: &str, b: &str| {
        if cfg!(windows) {
            a.eq_ignore_ascii_case(b)
        } else {
            a == b
        }
    };
    let mut out: Vec<(String, OsString)> = project
        .iter()
        .filter(|(k, _)| !xdev_workspace::is_reserved(k))
        .map(|(k, v)| (k.clone(), OsString::from(v)))
        .collect();
    let taken: Vec<String> = out.iter().map(|(k, _)| k.clone()).collect();
    out.extend(network_env(s, &|name| {
        is_set(name) || taken.iter().any(|t| same(t, name))
    }));
    out
}

fn network_env(s: &NetworkSettings, is_set: &dyn Fn(&str) -> bool) -> Vec<(String, OsString)> {
    let mut out: Vec<(String, OsString)> = Vec::new();
    let mut add = |name: &str, value: &str| {
        let taken = |n: &str| {
            if cfg!(windows) {
                n.eq_ignore_ascii_case(name)
            } else {
                n == name
            }
        };
        if is_set(name) || out.iter().any(|(n, _)| taken(n)) {
            return;
        }
        out.push((name.to_owned(), OsString::from(value)));
    };
    let proxy = s.proxy_url.trim();
    if !proxy.is_empty() && validate_proxy(proxy).is_ok() {
        for name in [
            "HTTP_PROXY",
            "http_proxy",
            "HTTPS_PROXY",
            "https_proxy",
            "ALL_PROXY",
            "all_proxy",
        ] {
            add(name, proxy);
        }
        let bypass = clean_no_proxy(&s.no_proxy).join(",");
        if !bypass.is_empty() {
            add("NO_PROXY", &bypass);
            add("no_proxy", &bypass);
        }
    }
    let mirror = s.node_mirror.trim();
    if !mirror.is_empty() && validate_mirror(mirror).is_ok() {
        add("npm_config_registry", mirror);
    }
    out
}

/// The repo whose folder, worktree folder or worktree holds `cwd`; the
/// deepest match wins, so a repo nested in another gets its own.
pub(crate) fn repo_for_cwd<'a>(
    reg: &'a xdev_workspace::Registry,
    cwd: &std::path::Path,
) -> Option<&'a xdev_workspace::RepoEntry> {
    let key = xdev_workspace::path_key(cwd);
    let inside = |root: &std::path::Path| {
        let r = xdev_workspace::path_key(root);
        (key == r || key.starts_with(&format!("{r}/"))).then_some(r.len())
    };
    reg.repos
        .iter()
        .filter_map(|repo| {
            let own = [inside(&repo.path), inside(&repo.worktree_root)];
            let trees = reg
                .worktrees
                .iter()
                .filter(|w| w.repo_id == repo.id)
                .map(|w| inside(&w.path));
            own.into_iter()
                .chain(trees)
                .flatten()
                .max()
                .map(|n| (n, repo))
        })
        .max_by_key(|(n, _)| *n)
        .map(|(_, repo)| repo)
}

/// Lays the environment of the repo `cwd` belongs to over `env`: a project
/// variable replaces an inherited one of the same name and never an `XDEV_*`
/// one. Nothing happens when `cwd` is in no repo.
#[allow(dead_code)] // called from the launch path in pty.rs once it adopts it
pub(crate) fn add_project_env(
    env: &mut Vec<(String, OsString)>,
    reg: &xdev_workspace::Registry,
    secrets: &dyn xdev_workspace::SecretStore,
    cwd: &std::path::Path,
) {
    let Some(repo) = repo_for_cwd(reg, cwd) else {
        return;
    };
    let vars = xdev_workspace::merge_env(&repo.env, &|key| secrets.get(&repo.id, key));
    for (key, value) in vars {
        env.retain(|(k, _)| {
            if cfg!(windows) {
                !k.eq_ignore_ascii_case(&key)
            } else {
                *k != key
            }
        });
        env.push((key, OsString::from(value)));
    }
}

/// What an HTTP client should use.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct ClientProxy {
    pub url: Option<tauri::Url>,
    /// Comma separated, `NO_PROXY` style.
    pub no_proxy: Option<String>,
}

/// The proxy for a client, and a warning when the stored one is invalid (then
/// no proxy is used).
pub(crate) fn client_proxy(s: &NetworkSettings) -> (ClientProxy, Option<String>) {
    let raw = s.proxy_url.trim();
    if raw.is_empty() {
        return (ClientProxy::default(), None);
    }
    match parse_with(raw, &["http", "https", "socks5", "socks5h"]) {
        Ok(url) => {
            let list = clean_no_proxy(&s.no_proxy).join(",");
            (
                ClientProxy {
                    url: Some(url),
                    no_proxy: (!list.is_empty()).then_some(list),
                },
                None,
            )
        }
        Err(e) => (
            ClientProxy::default(),
            Some(format!("the proxy setting is ignored: {e}")),
        ),
    }
}

/// `client_proxy`, logging the warning.
pub(crate) fn client_proxy_logged(s: &NetworkSettings) -> ClientProxy {
    let (proxy, warning) = client_proxy(s);
    if let Some(w) = warning {
        applog::warn("network", &w);
    }
    proxy
}

/// Whether `host` matches a bypass pattern: `*`, a host, `.suffix`, `*.suffix`.
pub(crate) fn bypasses(host: &str, patterns: &[String]) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    patterns.iter().any(|p| {
        let p = p.trim().to_ascii_lowercase();
        if p == "*" {
            return true;
        }
        let suffix = p.trim_start_matches('*').trim_start_matches('.');
        if suffix.is_empty() {
            return false;
        }
        host == suffix || host.ends_with(&format!(".{suffix}"))
    })
}

/// The proxy for a request to `host`, `None` when it is unset, invalid or bypassed.
pub(crate) fn proxy_for_host(s: &NetworkSettings, host: &str) -> Option<tauri::Url> {
    let proxy = client_proxy_logged(s);
    let url = proxy.url?;
    let list: Vec<String> = proxy
        .no_proxy
        .map(|l| l.split(',').map(str::to_owned).collect())
        .unwrap_or_default();
    (!bypasses(host, &list)).then_some(url)
}

/// A reqwest client builder with `proxy` applied.
pub(crate) fn apply_to_client(
    builder: reqwest::ClientBuilder,
    proxy: &ClientProxy,
) -> reqwest::ClientBuilder {
    let Some(url) = &proxy.url else {
        return builder;
    };
    match reqwest::Proxy::all(url.as_str()) {
        Ok(p) => {
            let p = match &proxy.no_proxy {
                Some(list) => p.no_proxy(reqwest::NoProxy::from_string(list)),
                None => p,
            };
            builder.proxy(p)
        }
        Err(e) => {
            applog::warn("network", &format!("the proxy setting is ignored: {e}"));
            builder
        }
    }
}

/// The name shown in About and the diagnostics file: the chosen one, else the OS host name.
pub(crate) fn machine_name(s: &NetworkSettings) -> String {
    let own = clean_machine_name(&s.machine_name);
    if own.is_empty() { os_hostname() } else { own }
}

fn os_hostname() -> String {
    for var in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(v) = std::env::var(var) {
            let v = clean_machine_name(&v);
            if !v.is_empty() {
                return v;
            }
        }
    }
    if let Ok(v) = std::fs::read_to_string("/etc/hostname") {
        let v = clean_machine_name(&v);
        if !v.is_empty() {
            return v;
        }
    }
    std::process::Command::new("hostname")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|v| clean_machine_name(&v))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn net(proxy: &str, bypass: &[&str], mirror: &str) -> NetworkSettings {
        NetworkSettings {
            proxy_url: proxy.into(),
            no_proxy: bypass.iter().map(|s| (*s).into()).collect(),
            node_mirror: mirror.into(),
            machine_name: String::new(),
        }
    }

    fn env_map(v: Vec<(String, OsString)>) -> std::collections::HashMap<String, String> {
        v.into_iter()
            .map(|(k, v)| (k, v.to_string_lossy().into_owned()))
            .collect()
    }

    #[test]
    fn old_json_without_network_loads_defaults() {
        let s: crate::settings::Settings = serde_json::from_str(r#"{"ui":{}}"#).unwrap();
        assert_eq!(s.network, NetworkSettings::default());
        let bad: crate::settings::Settings =
            serde_json::from_str(r#"{"network":{"proxyUrl":5}}"#).unwrap();
        assert_eq!(bad.network, NetworkSettings::default());
        let part: crate::settings::Settings =
            serde_json::from_str(r#"{"network":{"nodeMirror":"https://m.example"}}"#).unwrap();
        assert_eq!(part.network.node_mirror, "https://m.example");
        assert_eq!(part.network.proxy_url, "");
    }

    #[test]
    fn proxy_validation() {
        for ok in [
            "",
            "  ",
            "http://127.0.0.1:8080",
            "https://proxy.corp",
            "socks5://localhost:1080",
            "http://user:pw@proxy.corp:3128",
        ] {
            assert!(validate_proxy(ok).is_ok(), "{ok}");
        }
        assert_eq!(validate_proxy("ftp://p.corp"), Err(UrlError::Scheme));
        assert_eq!(validate_proxy("localhost:8080"), Err(UrlError::Scheme));
        assert_eq!(validate_proxy("proxy.corp"), Err(UrlError::Unparsable));
        assert_eq!(validate_proxy("http://"), Err(UrlError::Unparsable));
        assert_eq!(validate_proxy("http://a b"), Err(UrlError::Unparsable));
        assert!(validate_mirror("https://registry.npmmirror.com").is_ok());
        assert!(validate_mirror("socks5://x").is_err());
    }

    #[test]
    fn bypass_list_is_cleaned() {
        let raw = vec![
            " localhost , 10.0.0.0/8".to_owned(),
            "".into(),
            "LOCALHOST".into(),
            ".corp.example".into(),
            "has space".into(),
        ];
        assert_eq!(
            clean_no_proxy(&raw),
            ["localhost", "10.0.0.0/8", ".corp.example"]
        );
        let many: Vec<String> = (0..300).map(|i| format!("h{i}")).collect();
        assert_eq!(clean_no_proxy(&many).len(), MAX_NO_PROXY);
        assert_eq!(clean_machine_name(&"a".repeat(100)).len(), MAX_NAME);
        assert_eq!(clean_machine_name("  box\u{7} 1 "), "box 1");
    }

    #[test]
    fn put_names_the_invalid_field() {
        assert_eq!(invalid_field(&net("nope", &[], "")), Some("proxyUrl"));
        assert_eq!(invalid_field(&net("", &[], "ftp://x")), Some("nodeMirror"));
        assert_eq!(invalid_field(&net("http://p:1", &[], "")), None);
    }

    #[test]
    fn terminal_env_sets_every_form() {
        let env = env_map(terminal_env(
            &net(
                "http://p:8080",
                &["localhost", ".corp"],
                "https://m.example",
            ),
            &|_| false,
        ));
        for k in [
            "HTTP_PROXY",
            "http_proxy",
            "HTTPS_PROXY",
            "https_proxy",
            "ALL_PROXY",
            "all_proxy",
        ] {
            if cfg!(windows) && k.chars().any(|c| c.is_ascii_lowercase()) {
                // Names are case-blind there, so the upper form is the one set.
                assert!(!env.contains_key(k), "{k}");
                continue;
            }
            assert_eq!(env[k], "http://p:8080", "{k}");
        }
        assert_eq!(env["NO_PROXY"], "localhost,.corp");
        if !cfg!(windows) {
            assert_eq!(env["no_proxy"], "localhost,.corp");
        }
        assert_eq!(env["npm_config_registry"], "https://m.example");
    }

    #[test]
    fn terminal_env_never_overrides_and_skips_the_unset() {
        let none = terminal_env(&NetworkSettings::default(), &|_| false);
        assert!(none.is_empty());
        let env = env_map(terminal_env(
            &net("http://p:8080", &["a"], "https://m.example"),
            &|n| n == "HTTPS_PROXY" || n == "npm_config_registry",
        ));
        assert!(!env.contains_key("HTTPS_PROXY"));
        assert!(!env.contains_key("npm_config_registry"));
        assert_eq!(env["HTTP_PROXY"], "http://p:8080");
        // An invalid proxy adds nothing; the mirror still applies.
        let env = env_map(terminal_env(
            &net("bad", &["a"], "https://m.example"),
            &|_| false,
        ));
        assert_eq!(env.len(), 1);
        // No bypass entries: no NO_PROXY.
        let env = env_map(terminal_env(&net("http://p:1", &[], ""), &|_| false));
        assert!(!env.contains_key("NO_PROXY"));
    }

    #[test]
    fn client_proxy_config_and_invalid_fallback() {
        let (none, warn) = client_proxy(&NetworkSettings::default());
        assert_eq!(none, ClientProxy::default());
        assert!(warn.is_none());
        let (p, warn) = client_proxy(&net("http://p:8080", &["localhost", "x.corp"], ""));
        assert_eq!(p.url.unwrap().as_str(), "http://p:8080/");
        assert_eq!(p.no_proxy.as_deref(), Some("localhost,x.corp"));
        assert!(warn.is_none());
        let (bad, warn) = client_proxy(&net("ftp://nope", &["localhost"], ""));
        assert_eq!(bad, ClientProxy::default());
        assert!(warn.unwrap().contains("ignored"));
        // The logged form falls back the same way (a client is not built: the
        // TLS provider is installed by the app, not in tests).
        let used = client_proxy_logged(&net("garbage", &[], ""));
        assert!(used.url.is_none());
        let ok = client_proxy_logged(&net("http://p:8080", &["a.corp"], ""));
        assert!(ok.url.is_some());
    }

    #[test]
    fn bypass_matching_and_host_choice() {
        let list = vec!["localhost".to_owned(), ".corp.example".into()];
        assert!(bypasses("localhost", &list));
        assert!(bypasses("git.corp.example", &list));
        assert!(bypasses("corp.example", &list));
        assert!(!bypasses("evilcorp.example", &list));
        assert!(bypasses("anything", &["*".to_owned()]));
        let s = net("http://p:8080", &["github.com"], "");
        assert!(proxy_for_host(&s, "github.com").is_none());
        assert!(proxy_for_host(&s, "api.github.com").is_none());
        assert!(proxy_for_host(&s, "example.org").is_some());
        assert!(proxy_for_host(&net("bad", &[], ""), "example.org").is_none());
    }

    #[test]
    fn machine_name_prefers_the_chosen_one() {
        let s = NetworkSettings {
            machine_name: " dev box ".into(),
            ..Default::default()
        };
        assert_eq!(machine_name(&s), "dev box");
    }

    #[test]
    fn normalized_cleans_every_field() {
        let s = NetworkSettings {
            proxy_url: " http://p:1 ".into(),
            no_proxy: vec!["a, b".into(), "a".into()],
            node_mirror: " https://m ".into(),
            machine_name: "  n ".into(),
        }
        .normalized();
        assert_eq!(s.proxy_url, "http://p:1");
        assert_eq!(s.no_proxy, ["a", "b"]);
        assert_eq!(s.node_mirror, "https://m");
        assert_eq!(s.machine_name, "n");
    }

    fn repo(
        id: &str,
        path: &str,
        env: Vec<xdev_workspace::RepoEnvVar>,
    ) -> xdev_workspace::RepoEntry {
        xdev_workspace::RepoEntry {
            id: id.into(),
            short_name: id.into(),
            path: path.into(),
            worktree_root: format!("{path}-wt").into(),
            env,
            ..Default::default()
        }
    }

    fn var(key: &str, value: &str, secret: bool) -> xdev_workspace::RepoEnvVar {
        xdev_workspace::RepoEnvVar {
            key: key.into(),
            value: value.into(),
            secret,
        }
    }

    #[test]
    fn project_env_overrides_inherited_but_not_the_apps_own() {
        let project = vec![
            ("HTTP_PROXY".to_owned(), "http://mine:1".to_owned()),
            ("FOO".to_owned(), "bar".to_owned()),
            ("XDEV_ROOT_PATH".to_owned(), "evil".to_owned()),
        ];
        let env = env_map(terminal_env_with_project(
            &net("http://p:8080", &[], ""),
            &project,
            &|n| n == "FOO" || n == "HTTP_PROXY",
        ));
        assert_eq!(env["FOO"], "bar");
        assert_eq!(env["HTTP_PROXY"], "http://mine:1");
        assert!(!env.contains_key("XDEV_ROOT_PATH"));
        // The network settings still fill the names the project did not set.
        assert_eq!(env["HTTPS_PROXY"], "http://p:8080");
    }

    #[test]
    fn terminal_env_without_a_project_is_unchanged() {
        let n = net("http://p:8080", &[], "https://m.example");
        assert_eq!(
            terminal_env(&n, &|_| false),
            terminal_env_with_project(&n, &[], &|_| false)
        );
    }

    #[test]
    fn a_repo_is_found_from_its_folder_a_worktree_or_the_worktree_root() {
        let mut reg = xdev_workspace::Registry::default();
        reg.repos.push(repo("a", "/work/a", vec![]));
        reg.repos.push(repo("b", "/work/a/nested/b", vec![]));
        reg.worktrees.push(
            serde_json::from_str(
                r#"{"repo_id":"a","path":"/elsewhere/feat","start":"","pinned":false,"created_ms":0,"made_here":false}"#,
            )
            .unwrap(),
        );
        let id = |p: &str| repo_for_cwd(&reg, std::path::Path::new(p)).map(|r| r.id.as_str());
        assert_eq!(id("/work/a/src"), Some("a"));
        assert_eq!(id("/work/a-wt/x/y"), Some("a"));
        assert_eq!(id("/elsewhere/feat/sub"), Some("a"));
        assert_eq!(id("/work/a/nested/b/src"), Some("b"));
        assert_eq!(id("/work/ab"), None);
        assert_eq!(id("/tmp"), None);
    }

    #[test]
    fn add_project_env_replaces_inherited_and_reads_secrets_from_the_store() {
        let mut reg = xdev_workspace::Registry::default();
        reg.repos.push(repo(
            "a",
            "/work/a",
            vec![
                var("PLAIN", "p", false),
                var("TOKEN", "", true),
                var("XDEV_ROOT_PATH", "evil", false),
            ],
        ));
        let secrets = crate::repo_env::MemorySecrets::default();
        xdev_workspace::SecretStore::set(&secrets, "a", "TOKEN", "s3").unwrap();
        let mut env: Vec<(String, OsString)> = vec![
            ("PLAIN".into(), "old".into()),
            ("XDEV_ROOT_PATH".into(), "/work/a".into()),
        ];
        add_project_env(&mut env, &reg, &secrets, std::path::Path::new("/work/a/x"));
        let env = env_map(env);
        assert_eq!(env["PLAIN"], "p");
        assert_eq!(env["TOKEN"], "s3");
        assert_eq!(env["XDEV_ROOT_PATH"], "/work/a");

        let mut other: Vec<(String, OsString)> = vec![];
        add_project_env(&mut other, &reg, &secrets, std::path::Path::new("/tmp"));
        assert!(other.is_empty());
    }
}
