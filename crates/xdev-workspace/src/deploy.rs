//! The `[[deploy]]` presets and the `[vps]` target of a repo's `xdev.toml`,
//! and the presets detected from a worktree's files. Presets run as a
//! visible command in a terminal tab; the repo's own are trusted by hash.
//!
//! ```toml
//! [[deploy]]
//! name = "Production"
//! run = "vercel deploy --prod"
//! confirm = true            # optional, default false
//!
//! [vps]
//! host = "prod-1"           # an SSH hosts alias
//! cwd = "/srv/app"          # optional
//! notes = "docs/deploy.md"  # optional, repo-relative
//! ```

use std::path::{Component, Path};

use serde::{Deserialize, Serialize};

use crate::hooks::{TrustKind, file_of, hash_of, load_trust, read_text, record_trust, repo_of};
use crate::{Registry, WorkspaceError};

/// The longest preset name, in characters.
pub const NAME_MAX: usize = 60;
/// The longest preset command, in characters.
pub const RUN_MAX: usize = 1000;
/// The most `[[deploy]]` entries read.
pub const DEPLOY_MAX: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum PresetSource {
    /// Built in, found from the worktree's files.
    Detected,
    /// From `xdev.toml`.
    Repo,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DeployPreset {
    pub name: String,
    pub run: String,
    /// Ask before running.
    pub confirm: bool,
    pub source: PresetSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct VpsTarget {
    pub host: String,
    pub cwd: Option<String>,
    /// Repo-relative, spelled with `/`.
    pub notes: Option<String>,
}

/// Why `xdev.toml` has no usable targets.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct ParseError(pub String);

/// What a worktree's `xdev.toml` says about targets.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RepoTargets {
    pub deploy: Vec<DeployPreset>,
    pub vps: Option<VpsTarget>,
    /// Blake3 hex of the two parts; empty when the file has neither.
    pub hash: String,
    /// There is nothing to trust, or the person trusted this `hash`.
    pub trusted: bool,
    /// The file's text, for the trust dialog; `None` when there is none.
    pub text: Option<String>,
    /// Why the file was not used.
    pub error: Option<String>,
}

fn text_of<'a>(table: &'a toml::Table, key: &str, at: &str) -> Result<Option<&'a str>, ParseError> {
    match table.get(key) {
        None => Ok(None),
        Some(toml::Value::String(s)) => Ok(Some(s)),
        Some(_) => Err(ParseError(format!("{at}.{key} must be a string"))),
    }
}

/// The `[[deploy]]` and `[vps]` tables of an `xdev.toml`. Other keys are
/// ignored. A bad type or a value `validate` refuses is an error.
pub fn parse(toml_text: &str) -> Result<(Vec<DeployPreset>, Option<VpsTarget>), ParseError> {
    let table: toml::Table = toml::from_str(toml_text).map_err(|e| ParseError(e.to_string()))?;
    let mut deploy = Vec::new();
    match table.get("deploy") {
        None => {}
        Some(toml::Value::Array(items)) => {
            if items.len() > DEPLOY_MAX {
                return Err(ParseError(format!(
                    "deploy has more than {DEPLOY_MAX} entries"
                )));
            }
            for (i, item) in items.iter().enumerate() {
                let at = format!("deploy[{i}]");
                let toml::Value::Table(entry) = item else {
                    return Err(ParseError(format!("{at} must be a table")));
                };
                let name = text_of(entry, "name", &at)?
                    .map(str::trim)
                    .unwrap_or_default();
                let run = text_of(entry, "run", &at)?
                    .map(str::trim)
                    .unwrap_or_default();
                let confirm = match entry.get("confirm") {
                    None => false,
                    Some(toml::Value::Boolean(b)) => *b,
                    Some(_) => {
                        return Err(ParseError(format!("{at}.confirm must be true or false")));
                    }
                };
                deploy.push(DeployPreset {
                    name: name.to_owned(),
                    run: run.to_owned(),
                    confirm,
                    source: PresetSource::Repo,
                });
            }
        }
        Some(_) => return Err(ParseError("deploy must be an array of tables".into())),
    }
    let vps = match table.get("vps") {
        None => None,
        Some(toml::Value::Table(t)) => {
            let host = text_of(t, "host", "vps")?
                .map(str::trim)
                .unwrap_or_default();
            let opt = |key: &str| -> Result<Option<String>, ParseError> {
                Ok(text_of(t, key, "vps")?
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned))
            };
            Some(VpsTarget {
                host: host.to_owned(),
                cwd: opt("cwd")?,
                notes: opt("notes")?.map(|n| n.replace('\\', "/")),
            })
        }
        Some(_) => return Err(ParseError("vps must be a table".into())),
    };
    validate(&deploy, vps.as_ref())?;
    Ok((deploy, vps))
}

/// Checks the limits: `name` 1 to 60 characters, `run` 1 to 1,000 with no
/// newline, `host` set with no whitespace, `cwd` with no newline, `notes`
/// relative with no `..`.
pub fn validate(deploy: &[DeployPreset], vps: Option<&VpsTarget>) -> Result<(), ParseError> {
    let bad = |m: String| Err(ParseError(m));
    for (i, p) in deploy.iter().enumerate() {
        if p.name.is_empty() || p.name.chars().count() > NAME_MAX {
            return bad(format!(
                "deploy[{i}].name must be 1 to {NAME_MAX} characters"
            ));
        }
        if p.run.is_empty() || p.run.chars().count() > RUN_MAX {
            return bad(format!("deploy[{i}].run must be 1 to {RUN_MAX} characters"));
        }
        if p.run.contains(['\n', '\r']) {
            return bad(format!("deploy[{i}].run must be one line"));
        }
    }
    if let Some(v) = vps {
        if v.host.is_empty() || v.host.contains(char::is_whitespace) || v.host.starts_with('-') {
            return bad("vps.host must be a host alias".into());
        }
        if v.cwd.as_deref().is_some_and(|c| c.contains(['\n', '\r'])) {
            return bad("vps.cwd must be one line".into());
        }
        if let Some(notes) = &v.notes {
            let path = Path::new(notes);
            let rooted = notes.starts_with(['/', '\\'])
                || path.is_absolute()
                || path.has_root()
                || notes.as_bytes().get(1) == Some(&b':');
            let up = notes.split(['/', '\\']).any(|s| s == "..")
                || path.components().any(|c| matches!(c, Component::ParentDir));
            if rooted || up || notes.contains(['\n', '\r', '\0']) {
                return bad("vps.notes must be a path inside the repo".into());
            }
        }
    }
    Ok(())
}

/// The presets found from the worktree's files. `on_path` says whether a
/// program is on `PATH`.
pub fn detect(root: &Path, on_path: impl Fn(&str) -> bool) -> Vec<DeployPreset> {
    let has = |name: &str| root.join(name).is_file();
    let preset = |name: &str, run: &str, confirm: bool| DeployPreset {
        name: name.to_owned(),
        run: run.to_owned(),
        confirm,
        source: PresetSource::Detected,
    };
    let mut out = Vec::new();
    if has("vercel.json") || root.join(".vercel").join("project.json").is_file() {
        out.push(preset("Vercel preview", "vercel deploy", false));
        out.push(preset("Vercel production", "vercel deploy --prod", true));
    }
    if has("wrangler.toml") || has("wrangler.json") || has("wrangler.jsonc") {
        let run = if on_path("wrangler") {
            "wrangler deploy"
        } else {
            "npx wrangler deploy"
        };
        out.push(preset("Cloudflare deploy", run, true));
    }
    out
}

/// The detected presets, with a repo preset replacing one of the same name
/// (in its place); other repo presets follow.
pub fn merge(detected: Vec<DeployPreset>, repo: Vec<DeployPreset>) -> Vec<DeployPreset> {
    let mut out = detected;
    for preset in repo {
        match out.iter_mut().find(|p| p.name == preset.name) {
            Some(slot) => *slot = preset,
            None => out.push(preset),
        }
    }
    out
}

/// Blake3 hex over the presets' name, run and confirm and the vps target,
/// in a fixed JSON spelling; `source` and the file's spacing do not matter.
/// Empty when there are neither presets nor a target.
pub fn trust_hash(deploy: &[DeployPreset], vps: Option<&VpsTarget>) -> String {
    if deploy.is_empty() && vps.is_none() {
        return String::new();
    }
    let deploy: Vec<serde_json::Value> = deploy
        .iter()
        .map(|p| serde_json::json!([p.name, p.run, p.confirm]))
        .collect();
    let vps = vps.map(|v| serde_json::json!([v.host, v.cwd, v.notes]));
    hash_of(&serde_json::json!({ "deploy": deploy, "vps": vps }).to_string())
}

/// The targets of the worktree's `xdev.toml`, else of the primary
/// checkout's, with whether the person trusted them. A file that cannot be
/// read or parsed gives no targets and an `error`.
pub fn repo_targets(
    reg: &Registry,
    data: &Path,
    worktree: &Path,
) -> Result<RepoTargets, WorkspaceError> {
    let repo = repo_of(reg, worktree)?;
    let failed = |reason: String| RepoTargets {
        trusted: true,
        error: Some(reason),
        ..RepoTargets::default()
    };
    let text = match file_of(repo, worktree, read_text) {
        Ok(Some(text)) => text,
        Ok(None) => {
            return Ok(RepoTargets {
                trusted: true,
                ..RepoTargets::default()
            });
        }
        Err(reason) => return Ok(failed(reason)),
    };
    let (deploy, vps) = match parse(&text) {
        Ok(parts) => parts,
        Err(e) => return Ok(failed(e.0)),
    };
    let hash = trust_hash(&deploy, vps.as_ref());
    let trusted = hash.is_empty() || load_trust(data).has(&repo.id, TrustKind::Targets, &hash);
    Ok(RepoTargets {
        deploy,
        vps,
        hash,
        trusted,
        text: Some(text),
        error: None,
    })
}

/// Trusts the worktree's current targets; `HookUntrusted` when `hash` is
/// not theirs (the file changed, or there are none).
pub fn trust_targets(
    reg: &Registry,
    data: &Path,
    worktree: &Path,
    hash: &str,
    now_ms: i64,
) -> Result<(), WorkspaceError> {
    let current = repo_targets(reg, data, worktree)?;
    if current.hash.is_empty() || current.hash != hash {
        return Err(WorkspaceError::HookUntrusted("targets".into()));
    }
    let repo = repo_of(reg, worktree)?;
    record_trust(data, &repo.id, TrustKind::Targets, hash, now_ms)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::*;
    use crate::hooks::FILE_NAME;
    use crate::{RepoEntry, WorktreeMeta};

    const GOOD: &str = r#"
        version = 3
        [[deploy]]
        name = "Staging"
        run = "make stage"
        extra = 1
        [[deploy]]
        name = "Prod"
        run = "make prod"
        confirm = true
        [vps]
        host = "prod-1"
        cwd = "/srv/app"
        notes = "docs/deploy.md"
        other = "x"
    "#;

    #[test]
    fn parse_reads_good_input_and_ignores_unknown_keys() {
        let (deploy, vps) = parse(GOOD).unwrap();
        assert_eq!(deploy.len(), 2);
        assert_eq!(deploy[0].name, "Staging");
        assert!(!deploy[0].confirm);
        assert!(deploy[1].confirm);
        assert_eq!(deploy[1].source, PresetSource::Repo);
        let vps = vps.unwrap();
        assert_eq!(vps.host, "prod-1");
        assert_eq!(vps.cwd.as_deref(), Some("/srv/app"));
        assert_eq!(vps.notes.as_deref(), Some("docs/deploy.md"));
        assert_eq!(parse("name = 'x'").unwrap(), (Vec::new(), None));
    }

    #[test]
    fn parse_refuses_a_bad_type() {
        assert!(parse("deploy = 3").is_err());
        assert!(parse("[[deploy]]\nname = 1\nrun = 'x'").is_err());
        assert!(parse("[[deploy]]\nname = 'a'\nrun = 'x'\nconfirm = 'yes'").is_err());
        assert!(parse("vps = 'prod'").is_err());
        assert!(parse("[[deploy]]\nname = 'a'").is_err());
    }

    fn preset(name: &str, run: &str) -> DeployPreset {
        DeployPreset {
            name: name.into(),
            run: run.into(),
            confirm: false,
            source: PresetSource::Repo,
        }
    }

    #[test]
    fn detect_finds_vercel() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(detect(tmp.path(), |_| true).is_empty());
        fs::write(tmp.path().join("vercel.json"), "{}").unwrap();
        let found = detect(tmp.path(), |_| true);
        let names: Vec<_> = found.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["Vercel preview", "Vercel production"]);
        assert_eq!(found[0].run, "vercel deploy");
        assert!(!found[0].confirm);
        assert_eq!(found[1].run, "vercel deploy --prod");
        assert!(found[1].confirm);
        assert!(found.iter().all(|p| p.source == PresetSource::Detected));
    }

    #[test]
    fn detect_finds_vercel_project_dir() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir(tmp.path().join(".vercel")).unwrap();
        fs::write(tmp.path().join(".vercel").join("project.json"), "{}").unwrap();
        assert_eq!(detect(tmp.path(), |_| false).len(), 2);
    }

    #[test]
    fn detect_finds_wrangler_and_falls_back_to_npx() {
        for file in ["wrangler.toml", "wrangler.json", "wrangler.jsonc"] {
            let tmp = tempfile::tempdir().unwrap();
            fs::write(tmp.path().join(file), "").unwrap();
            let found = detect(tmp.path(), |p| p == "wrangler");
            assert_eq!(found.len(), 1);
            assert_eq!(found[0].name, "Cloudflare deploy");
            assert_eq!(found[0].run, "wrangler deploy");
            assert!(found[0].confirm);
            let found = detect(tmp.path(), |_| false);
            assert_eq!(found[0].run, "npx wrangler deploy");
        }
    }

    #[test]
    fn merge_lets_a_repo_preset_replace_a_detected_one() {
        let detected = vec![
            preset("Vercel preview", "vercel deploy"),
            preset("Vercel production", "vercel deploy --prod"),
        ];
        let repo = vec![
            preset("Vercel preview", "vercel deploy --yes"),
            preset("Staging", "make stage"),
        ];
        let out = merge(detected, repo);
        let view: Vec<_> = out
            .iter()
            .map(|p| (p.name.as_str(), p.run.as_str()))
            .collect();
        assert_eq!(
            view,
            [
                ("Vercel preview", "vercel deploy --yes"),
                ("Vercel production", "vercel deploy --prod"),
                ("Staging", "make stage"),
            ]
        );
    }

    #[test]
    fn trust_hash_is_stable_and_changes_on_any_edit() {
        let (deploy, vps) = parse(GOOD).unwrap();
        let base = trust_hash(&deploy, vps.as_ref());
        assert_eq!(base.len(), 64);
        // Comments, spacing and unknown keys are not part of it.
        let (d2, v2) = parse(&format!("# note\n{GOOD}\n")).unwrap();
        assert_eq!(trust_hash(&d2, v2.as_ref()), base);
        let mut d = deploy.clone();
        d[0].run.push('x');
        assert_ne!(trust_hash(&d, vps.as_ref()), base);
        let mut d = deploy.clone();
        d[0].name.push('x');
        assert_ne!(trust_hash(&d, vps.as_ref()), base);
        let mut d = deploy.clone();
        d[0].confirm = true;
        assert_ne!(trust_hash(&d, vps.as_ref()), base);
        let edits: [fn(&mut VpsTarget); 3] = [
            |v| v.host.push('x'),
            |v| v.cwd = None,
            |v| v.notes = Some("other.md".into()),
        ];
        for edit in edits {
            let mut v = vps.clone().unwrap();
            edit(&mut v);
            assert_ne!(trust_hash(&deploy, Some(&v)), base);
        }
        assert_ne!(trust_hash(&deploy, None), base);
        assert_eq!(trust_hash(&[], None), "");
    }

    #[test]
    fn validate_refuses_bad_values() {
        assert!(validate(&[preset("a", "make")], None).is_ok());
        assert!(validate(&[preset("a", "make\nrm -rf x")], None).is_err());
        assert!(validate(&[preset("a", "make\r")], None).is_err());
        assert!(validate(&[preset("", "make")], None).is_err());
        assert!(validate(&[preset(&"n".repeat(61), "make")], None).is_err());
        assert!(validate(&[preset(&"n".repeat(60), "make")], None).is_ok());
        assert!(validate(&[preset("a", &"r".repeat(1001))], None).is_err());
        assert!(validate(&[preset("a", &"r".repeat(1000))], None).is_ok());
        let vps = |cwd: Option<&str>, notes: Option<&str>| VpsTarget {
            host: "prod-1".into(),
            cwd: cwd.map(Into::into),
            notes: notes.map(Into::into),
        };
        assert!(validate(&[], Some(&vps(Some("/srv/a\nb"), None))).is_err());
        assert!(validate(&[], Some(&vps(None, Some("../x.md")))).is_err());
        assert!(validate(&[], Some(&vps(None, Some("docs/../../x.md")))).is_err());
        assert!(validate(&[], Some(&vps(None, Some("/etc/passwd")))).is_err());
        assert!(validate(&[], Some(&vps(None, Some("C:\\x.md")))).is_err());
        assert!(validate(&[], Some(&vps(Some("/srv/app"), Some("docs/deploy.md")))).is_ok());
        let no_host = VpsTarget {
            host: " ".into(),
            cwd: None,
            notes: None,
        };
        assert!(validate(&[], Some(&no_host)).is_err());
    }

    struct Fixture {
        _tmp: tempfile::TempDir,
        data: PathBuf,
        primary: PathBuf,
        worktree: PathBuf,
        reg: Registry,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        let primary = tmp.path().join("xdev");
        let worktree = tmp.path().join("wt").join("xdev-oak");
        for dir in [&data, &primary, &worktree] {
            fs::create_dir_all(dir).unwrap();
        }
        let reg = Registry {
            version: 1,
            repos: vec![RepoEntry {
                id: "abc".into(),
                short_name: "xdev".into(),
                path: primary.clone(),
                base_ref: "main".into(),
                worktree_root: tmp.path().join("wt"),
                ..RepoEntry::default()
            }],
            worktrees: vec![WorktreeMeta {
                repo_id: "abc".into(),
                path: worktree.clone(),
                start: "0".repeat(40),
                pinned: false,
                created_ms: 0,
                made_here: true,
                ..WorktreeMeta::default()
            }],
            vaults: Vec::new(),
            ..Registry::default()
        };
        Fixture {
            _tmp: tmp,
            data,
            primary,
            worktree,
            reg,
        }
    }

    #[test]
    fn trust_targets_records_the_current_hash_and_rejects_a_stale_one() {
        let f = fixture();
        fs::write(f.worktree.join(FILE_NAME), GOOD).unwrap();
        let view = repo_targets(&f.reg, &f.data, &f.worktree).unwrap();
        assert!(!view.trusted);
        assert_eq!(view.deploy.len(), 2);
        assert!(
            view.text
                .as_deref()
                .is_some_and(|t| t.contains("make prod"))
        );

        let stale = "0".repeat(64);
        assert!(matches!(
            trust_targets(&f.reg, &f.data, &f.worktree, &stale, 1),
            Err(WorkspaceError::HookUntrusted(_))
        ));
        assert!(!repo_targets(&f.reg, &f.data, &f.worktree).unwrap().trusted);

        trust_targets(&f.reg, &f.data, &f.worktree, &view.hash, 1).unwrap();
        assert!(repo_targets(&f.reg, &f.data, &f.worktree).unwrap().trusted);

        // An edit asks again, and the old hash no longer works.
        fs::write(
            f.worktree.join(FILE_NAME),
            GOOD.replace("make prod", "make prod --now"),
        )
        .unwrap();
        let edited = repo_targets(&f.reg, &f.data, &f.worktree).unwrap();
        assert!(!edited.trusted);
        assert!(trust_targets(&f.reg, &f.data, &f.worktree, &view.hash, 2).is_err());
    }

    #[test]
    fn a_worktree_without_the_file_reads_the_primary_checkouts() {
        let f = fixture();
        fs::write(f.primary.join(FILE_NAME), GOOD).unwrap();
        let view = repo_targets(&f.reg, &f.data, &f.worktree).unwrap();
        assert_eq!(view.deploy.len(), 2);
    }

    #[test]
    fn no_file_or_a_bad_file_gives_no_targets() {
        let f = fixture();
        let view = repo_targets(&f.reg, &f.data, &f.worktree).unwrap();
        assert!(view.trusted && view.deploy.is_empty() && view.hash.is_empty());
        fs::write(f.worktree.join(FILE_NAME), "[[deploy]]\nname = 1").unwrap();
        let view = repo_targets(&f.reg, &f.data, &f.worktree).unwrap();
        assert!(view.error.is_some() && view.deploy.is_empty());
        assert!(trust_targets(&f.reg, &f.data, &f.worktree, "", 1).is_err());
    }
}
