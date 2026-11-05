//! The agent profiles on this machine, kept in `<data dir>/profiles.json`:
//! the built-in CLIs, the owner's custom commands, the custom shells and the
//! global approvals switch.

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::catalog::modes;
use crate::flags::efforts;

const FILE: &str = "profiles.json";
const VERSION: u32 = 1;
const MAX_ID: usize = 32;
/// Shell ids the shell menu already uses (`shell:powershell`, ...).
const RESERVED_SHELLS: [&str; 3] = ["powershell", "cmd", "login"];

/// An agent CLI xDev knows. The table in `catalog` says the rest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum Cli {
    Claude,
    Codex,
    Gemini,
    Cursor,
    Copilot,
    Opencode,
    Amp,
    Droid,
    QwenCode,
    Kimi,
    Devin,
    Aider,
    Goose,
}

impl Cli {
    /// The built-in profiles, in menu order.
    pub const ALL: [Cli; 13] = [
        Cli::Claude,
        Cli::Codex,
        Cli::Gemini,
        Cli::Cursor,
        Cli::Copilot,
        Cli::Opencode,
        Cli::Amp,
        Cli::Droid,
        Cli::QwenCode,
        Cli::Kimi,
        Cli::Devin,
        Cli::Aider,
        Cli::Goose,
    ];

    /// The id of the CLI's built-in profile.
    pub fn as_str(self) -> &'static str {
        match self {
            Cli::Claude => "claude",
            Cli::Codex => "codex",
            Cli::Gemini => "gemini",
            Cli::Cursor => "cursor",
            Cli::Copilot => "copilot",
            Cli::Opencode => "opencode",
            Cli::Amp => "amp",
            Cli::Droid => "droid",
            Cli::QwenCode => "qwen-code",
            Cli::Kimi => "kimi",
            Cli::Devin => "devin",
            Cli::Aider => "aider",
            Cli::Goose => "goose",
        }
    }

    pub(crate) fn of_id(id: &str) -> Option<Cli> {
        Cli::ALL.into_iter().find(|cli| cli.as_str() == id)
    }

    fn title(self) -> &'static str {
        crate::catalog::spec(self).title
    }
}

/// How an agent asks before it acts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum Permissions {
    Ask,
    AcceptEdits,
    Auto,
    Skip,
}

impl Permissions {
    pub fn as_str(self) -> &'static str {
        match self {
            Permissions::Ask => "ask",
            Permissions::AcceptEdits => "accept-edits",
            Permissions::Auto => "auto",
            Permissions::Skip => "skip",
        }
    }
}

/// The global switch the built-in profiles follow until they opt out.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum Approvals {
    #[default]
    Ask,
    Auto,
    Skip,
}

/// Which agent a new agent tab starts. Stored and sent as `"auto"`,
/// `"blank"` or a profile id.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(type = "string"))]
pub enum DefaultAgent {
    /// The first installed, enabled agent of the auto order; a shell when
    /// there is none.
    #[default]
    Auto,
    /// A plain terminal.
    Blank,
    Agent(String),
}

impl DefaultAgent {
    pub fn as_str(&self) -> &str {
        match self {
            DefaultAgent::Auto => "auto",
            DefaultAgent::Blank => "blank",
            DefaultAgent::Agent(id) => id,
        }
    }

    pub fn parse(text: &str) -> DefaultAgent {
        match text {
            "auto" => DefaultAgent::Auto,
            "blank" => DefaultAgent::Blank,
            id => DefaultAgent::Agent(id.to_owned()),
        }
    }
}

impl Serialize for DefaultAgent {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for DefaultAgent {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(DefaultAgent::parse(&String::deserialize(d)?))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct EnvVar {
    pub name: String,
    pub value: String,
}

/// One way to start an agent. A built-in has a `cli`; a custom profile has
/// none and a `program`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub cli: Option<Cli>,
    #[serde(default)]
    pub program: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Vec<EnvVar>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub permissions: Option<Permissions>,
    /// A name in `accounts.json`.
    #[serde(default)]
    pub account: Option<String>,
    /// Shell lines run before the CLI.
    #[serde(default)]
    pub startup: Vec<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

impl Profile {
    /// Whether the global switch decides this profile's permissions: a
    /// built-in with no mode of its own and no args or env.
    pub fn follows_approvals(&self) -> bool {
        self.cli.is_some()
            && self.permissions.is_none()
            && self.args.is_empty()
            && self.env.is_empty()
    }
}

/// A shell the owner added to the `+` menu.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CustomShell {
    pub id: String,
    pub name: String,
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Profiles {
    pub approvals: Approvals,
    pub default_agent: DefaultAgent,
    /// A shell id without the `shell:` prefix (`powershell`, `fish`,
    /// `wsl:Ubuntu`); `None` picks the platform's own default.
    #[serde(default)]
    pub default_shell: Option<String>,
    pub profiles: Vec<Profile>,
    #[serde(default)]
    pub shells: Vec<CustomShell>,
}

/// The UI and CLI translate `code()`, never the message.
#[derive(Debug, thiserror::Error)]
pub enum ProfileError {
    #[error("profiles.json is unreadable or from a newer version")]
    Bad,
    #[error("invalid profile: {0}")]
    Invalid(String),
    #[error("no profile with this id")]
    Unknown,
    #[error("a built-in profile cannot be removed")]
    Builtin,
    #[error(transparent)]
    Io(#[from] io::Error),
}

impl ProfileError {
    pub fn code(&self) -> &'static str {
        match self {
            ProfileError::Bad => "bad_profiles",
            ProfileError::Invalid(_) => "invalid_profile",
            ProfileError::Unknown => "unknown_profile",
            ProfileError::Builtin => "builtin_profile",
            ProfileError::Io(_) => "io",
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OnDisk {
    version: u32,
    #[serde(default)]
    approvals: Approvals,
    #[serde(default)]
    default_agent: DefaultAgent,
    #[serde(default)]
    default_shell: Option<String>,
    #[serde(default)]
    profiles: Vec<Profile>,
    #[serde(default)]
    shells: Vec<CustomShell>,
}

fn default_true() -> bool {
    true
}

/// The built-in profile of `cli`, as first installed.
pub fn builtin(cli: Cli) -> Profile {
    Profile {
        id: cli.as_str().to_owned(),
        name: cli.title().to_owned(),
        cli: Some(cli),
        program: None,
        args: Vec::new(),
        env: Vec::new(),
        model: None,
        effort: None,
        permissions: None,
        account: None,
        startup: Vec::new(),
        enabled: true,
    }
}

/// Ids are `[a-z0-9-]{1,32}`; `shell` is the default shell's id. The
/// character set also keeps ids from starting with `shell:`.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID
        && id != "shell"
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

impl Default for Profiles {
    fn default() -> Self {
        Profiles {
            approvals: Approvals::Ask,
            default_agent: DefaultAgent::Auto,
            default_shell: None,
            profiles: Cli::ALL.into_iter().map(builtin).collect(),
            shells: Vec::new(),
        }
    }
}

impl Profiles {
    /// A file this version cannot fully understand is an error rather than
    /// the defaults, so a later `save` never wipes it.
    pub fn load(data_dir: &Path) -> Result<Profiles, ProfileError> {
        let text = match fs::read_to_string(data_dir.join(FILE)) {
            Ok(text) => text,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Profiles::default()),
            Err(e) if e.kind() == io::ErrorKind::InvalidData => return Err(ProfileError::Bad),
            Err(e) => return Err(ProfileError::Io(e)),
        };
        let disk: OnDisk = serde_json::from_str(&text).map_err(|_| ProfileError::Bad)?;
        if disk.version != VERSION {
            return Err(ProfileError::Bad);
        }
        let mut disk = disk;
        let mut default_agent = disk.default_agent.clone();
        rename_clashes(&mut disk.profiles, &mut default_agent);
        let mut found = Profiles {
            approvals: disk.approvals,
            default_agent,
            default_shell: disk.default_shell,
            profiles: Vec::with_capacity(disk.profiles.len()),
            shells: Vec::with_capacity(disk.shells.len()),
        };
        // Insert in file order, then lift the built-ins to the front.
        for profile in disk.profiles {
            if found.get(&profile.id).is_some() {
                return Err(ProfileError::Bad);
            }
            found
                .profiles
                .push(checked(profile).map_err(|_| ProfileError::Bad)?);
        }
        for shell in disk.shells {
            if found.shells.iter().any(|s| s.id == shell.id) {
                return Err(ProfileError::Bad);
            }
            found
                .shells
                .push(checked_shell(shell).map_err(|_| ProfileError::Bad)?);
        }
        let mut ordered = Vec::with_capacity(found.profiles.len() + Cli::ALL.len());
        for cli in Cli::ALL {
            let at = found.profiles.iter().position(|p| p.id == cli.as_str());
            ordered.push(match at {
                Some(at) => found.profiles.remove(at),
                None => builtin(cli),
            });
        }
        ordered.append(&mut found.profiles);
        found.profiles = ordered;
        if let DefaultAgent::Agent(id) = &found.default_agent
            && found.get(id).is_none()
        {
            return Err(ProfileError::Bad);
        }
        Ok(found)
    }

    pub fn save(&self, data_dir: &Path) -> Result<(), ProfileError> {
        let disk = OnDisk {
            version: VERSION,
            approvals: self.approvals,
            default_agent: self.default_agent.clone(),
            default_shell: self.default_shell.clone(),
            profiles: self.profiles.clone(),
            shells: self.shells.clone(),
        };
        let mut text = serde_json::to_string_pretty(&disk).map_err(io::Error::other)?;
        text.push('\n');
        write_atomic(data_dir, &text)?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Option<&Profile> {
        self.profiles.iter().find(|p| p.id == id)
    }

    /// Insert or replace by id; disabling the default agent resets it to `auto`. A built-in keeps its CLI whatever the caller
    /// sends; a custom profile cannot name one.
    pub fn put(&mut self, profile: Profile) -> Result<(), ProfileError> {
        let profile = checked(profile)?;
        // A disabled agent cannot stay the default; `auto` takes over.
        if !profile.enabled && self.default_agent == DefaultAgent::Agent(profile.id.clone()) {
            self.default_agent = DefaultAgent::Auto;
        }
        match self.profiles.iter_mut().find(|p| p.id == profile.id) {
            Some(slot) => *slot = profile,
            None => self.profiles.push(profile),
        }
        Ok(())
    }

    /// Built-in profiles stay. Removing the default agent's profile makes
    /// `claude` the default again.
    pub fn remove(&mut self, id: &str) -> Result<(), ProfileError> {
        let at = self
            .profiles
            .iter()
            .position(|p| p.id == id)
            .ok_or(ProfileError::Unknown)?;
        if self.profiles[at].cli.is_some() {
            return Err(ProfileError::Builtin);
        }
        self.profiles.remove(at);
        if self.default_agent == DefaultAgent::Agent(id.to_owned()) {
            self.default_agent = DefaultAgent::Auto;
        }
        Ok(())
    }

    /// Clears a built-in's args, env and mode so it follows the global
    /// Approvals again; model, effort, account and startup stay. A custom
    /// profile has nothing to reset and is left as it is.
    pub fn reset(&mut self, id: &str) -> Result<(), ProfileError> {
        let profile = self
            .profiles
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or(ProfileError::Unknown)?;
        if profile.cli.is_some() {
            profile.args.clear();
            profile.env.clear();
            profile.permissions = None;
        }
        Ok(())
    }

    /// Insert or replace by id.
    pub fn put_shell(&mut self, shell: CustomShell) -> Result<(), ProfileError> {
        let shell = checked_shell(shell)?;
        match self.shells.iter_mut().find(|s| s.id == shell.id) {
            Some(slot) => *slot = shell,
            None => self.shells.push(shell),
        }
        Ok(())
    }

    /// A removed shell that was the default stops being it.
    pub fn remove_shell(&mut self, id: &str) -> Result<(), ProfileError> {
        let at = self
            .shells
            .iter()
            .position(|s| s.id == id)
            .ok_or(ProfileError::Unknown)?;
        self.shells.remove(at);
        if self.default_shell.as_deref() == Some(id) {
            self.default_shell = None;
        }
        Ok(())
    }

    /// The default agent must be one of the profiles.
    pub fn set_defaults(
        &mut self,
        approvals: Approvals,
        default_agent: DefaultAgent,
        default_shell: Option<String>,
    ) -> Result<(), ProfileError> {
        if let DefaultAgent::Agent(id) = &default_agent
            && self.get(id).is_none()
        {
            return Err(ProfileError::Unknown);
        }
        self.approvals = approvals;
        self.default_agent = default_agent;
        self.default_shell = default_shell;
        Ok(())
    }

    /// The profile id a caller with no terminal to ask starts: the saved
    /// agent, else `claude`. The `auto` pick needs detection, which the UI
    /// does (`pick_agent`).
    pub fn default_id(&self) -> String {
        match &self.default_agent {
            DefaultAgent::Agent(id) => id.clone(),
            _ => Cli::Claude.as_str().to_owned(),
        }
    }

    /// What the profile runs as: its own mode, else the global switch when
    /// it follows it, else `ask`. A custom profile has no flag mapping, so it
    /// always asks.
    pub fn effective(&self, profile: &Profile) -> Permissions {
        if profile.cli.is_none() {
            return Permissions::Ask;
        }
        match profile.permissions {
            Some(mode) => mode,
            None if profile.follows_approvals() => {
                let offered = profile.cli.map(modes).unwrap_or_default();
                let want = match self.approvals {
                    Approvals::Ask => Permissions::Ask,
                    Approvals::Auto => Permissions::Auto,
                    Approvals::Skip => Permissions::Skip,
                };
                if offered.contains(&want) {
                    want
                } else {
                    Permissions::Ask
                }
            }
            None => Permissions::Ask,
        }
    }
}

/// The profile as it may be stored: shape checked, built-in CLI pinned.
fn checked(mut profile: Profile) -> Result<Profile, ProfileError> {
    if !valid_id(&profile.id) {
        return Err(invalid("id"));
    }
    if profile.name.trim().is_empty() {
        return Err(invalid("name"));
    }
    match Cli::of_id(&profile.id) {
        Some(cli) => profile.cli = Some(cli),
        None if profile.cli.is_some() => return Err(invalid("cli")),
        None => {}
    }
    // Only a CLI with an effort flag takes one; the lists live in `flags`.
    if let Some(effort) = profile.effort.as_deref()
        && !profile
            .cli
            .is_some_and(|cli| efforts(cli).contains(&effort))
    {
        return Err(invalid("effort"));
    }
    match profile.program.as_deref() {
        Some(program) if program.trim().is_empty() => return Err(invalid("program")),
        None if profile.cli.is_none() => return Err(invalid("program")),
        _ => {}
    }
    if profile
        .env
        .iter()
        .any(|e| e.name.is_empty() || e.name.contains(['=', '\0']) || e.value.contains('\0'))
    {
        return Err(invalid("env"));
    }
    Ok(profile)
}

/// A stored custom profile (a program, no CLI) whose id is now a built-in id is renamed
/// to the first free `<id>-custom`, `<id>-custom-2`, ...; the default agent
/// follows. Its program and args stay. The file is rewritten on the next save.
fn rename_clashes(profiles: &mut [Profile], default_agent: &mut DefaultAgent) {
    let taken: Vec<String> = profiles.iter().map(|p| p.id.clone()).collect();
    let mut used = taken.clone();
    for profile in profiles.iter_mut() {
        if profile.cli.is_some() || profile.program.is_none() || Cli::of_id(&profile.id).is_none() {
            continue;
        }
        let old = std::mem::take(&mut profile.id);
        let new = (1..)
            .map(|n| match n {
                1 => format!("{old}-custom"),
                n => format!("{old}-custom-{n}"),
            })
            .find(|id| !used.contains(id))
            .expect("an endless range has a free id");
        used.push(new.clone());
        if *default_agent == DefaultAgent::Agent(old) {
            *default_agent = DefaultAgent::Agent(new.clone());
        }
        profile.id = new;
    }
}

fn checked_shell(shell: CustomShell) -> Result<CustomShell, ProfileError> {
    if !valid_id(&shell.id) || RESERVED_SHELLS.contains(&shell.id.as_str()) {
        return Err(invalid("id"));
    }
    if shell.name.trim().is_empty() {
        return Err(invalid("name"));
    }
    if shell.program.trim().is_empty() {
        return Err(invalid("program"));
    }
    Ok(shell)
}

fn invalid(field: &str) -> ProfileError {
    ProfileError::Invalid(field.to_owned())
}

fn write_atomic(data_dir: &Path, content: &str) -> io::Result<()> {
    fs::create_dir_all(data_dir)?;
    // Same folder as the target so the rename never crosses a filesystem and
    // a reader never sees a half-written store.
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let tmp = data_dir.join(format!(
        ".{FILE}-{}-{}.tmp",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = File::create_new(&tmp)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, data_dir.join(FILE))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    const CLI_IDS: [&str; 13] = [
        "claude",
        "codex",
        "gemini",
        "cursor",
        "copilot",
        "opencode",
        "amp",
        "droid",
        "qwen-code",
        "kimi",
        "devin",
        "aider",
        "goose",
    ];

    fn ids(p: &Profiles) -> Vec<&str> {
        p.profiles.iter().map(|p| p.id.as_str()).collect()
    }

    fn custom(id: &str) -> Profile {
        Profile {
            id: id.to_owned(),
            name: "Mine".to_owned(),
            cli: None,
            program: Some("mine".to_owned()),
            ..builtin(Cli::Claude)
        }
    }

    fn code<T: std::fmt::Debug>(r: Result<T, ProfileError>) -> &'static str {
        r.unwrap_err().code()
    }

    #[test]
    fn missing_file_gives_builtins() {
        let d = tempdir();
        let p = Profiles::load(d.path()).unwrap();
        assert_eq!(ids(&p), CLI_IDS);
        assert_eq!(p.default_agent, DefaultAgent::Auto);
        assert_eq!(p.approvals, Approvals::Ask);
        assert_eq!(p.default_shell, None);
        assert!(p.shells.is_empty());
        assert_eq!(p.get("gemini").unwrap().name, "Gemini CLI");
        assert!(p.profiles.iter().all(|p| p.enabled && p.cli.is_some()));
    }

    #[test]
    fn save_is_atomic_and_reloads() {
        let d = tempdir();
        let mut p = Profiles::default();
        p.put(custom("mine-x")).unwrap();
        p.put_shell(CustomShell {
            id: "fish".into(),
            name: "Fish".into(),
            program: "fish".into(),
            args: vec!["-l".into()],
        })
        .unwrap();
        p.set_defaults(
            Approvals::Skip,
            DefaultAgent::Agent("mine-x".into()),
            Some("fish".into()),
        )
        .unwrap();
        p.save(d.path()).unwrap();
        assert_eq!(Profiles::load(d.path()).unwrap(), p);
        let names: Vec<_> = fs::read_dir(d.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, ["profiles.json"]);
    }

    #[test]
    fn saved_file_has_the_documented_shape() {
        let d = tempdir();
        Profiles::default().save(d.path()).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(d.path().join(FILE)).unwrap()).unwrap();
        assert_eq!(v["version"], 1);
        assert_eq!(v["approvals"], "ask");
        assert_eq!(v["defaultAgent"], "auto");
        assert!(v["defaultShell"].is_null());
        assert_eq!(v["profiles"][0]["cli"], "claude");
        assert_eq!(v["profiles"][0]["enabled"], true);
        assert!(v["shells"].as_array().unwrap().is_empty());
    }

    #[test]
    fn bad_file_is_refused_and_kept() {
        for text in [
            "{oops",
            "",
            r#"{"version":2}"#,
            r#"{"version":2,"approvals":"ask","defaultAgent":"claude","profiles":[],"shells":[]}"#,
            r#"{"version":1,"defaultAgent":"nope","profiles":[]}"#,
            r#"{"version":1,"defaultAgent":"claude","profiles":[{"id":"Bad","name":"x","enabled":true}]}"#,
            r#"{"version":1,"defaultAgent":"claude","profiles":[{"id":"claude","name":"a","enabled":true},{"id":"claude","name":"b","enabled":true}]}"#,
        ] {
            let d = tempdir();
            let path = d.path().join(FILE);
            fs::write(&path, text).unwrap();
            assert_eq!(code(Profiles::load(d.path())), "bad_profiles", "{text}");
            assert_eq!(fs::read_to_string(&path).unwrap(), text);
        }
    }

    #[test]
    fn missing_builtin_is_merged_in() {
        let d = tempdir();
        fs::write(
            d.path().join(FILE),
            r#"{"version":1,"defaultAgent":"claude","profiles":[
                {"id":"mine","name":"Mine","program":"mine","enabled":true},
                {"id":"claude","name":"Claude Code","enabled":false}]}"#,
        )
        .unwrap();
        let p = Profiles::load(d.path()).unwrap();
        assert_eq!(ids(&p)[13], "mine");
        // The file's own entry wins over the fresh built-in.
        assert!(!p.get("claude").unwrap().enabled);
        assert_eq!(p.get("claude").unwrap().cli, Some(Cli::Claude));
    }

    #[test]
    fn builtin_cannot_be_removed() {
        let mut p = Profiles::default();
        assert_eq!(code(p.remove("codex")), "builtin_profile");
        assert_eq!(code(p.remove("nope")), "unknown_profile");
        assert_eq!(ids(&p), CLI_IDS);
    }

    #[test]
    fn put_validates() {
        let mut p = Profiles::default();
        for id in ["Shell", "shell", "shell:x", "", &"a".repeat(33)] {
            assert_eq!(code(p.put(custom(id))), "invalid_profile", "{id}");
        }
        p.put(custom(&"a".repeat(32))).unwrap();

        let mut no_program = custom("mine");
        no_program.program = None;
        assert_eq!(code(p.put(no_program)), "invalid_profile");
        let mut blank_program = custom("mine");
        blank_program.program = Some("  ".into());
        assert_eq!(code(p.put(blank_program)), "invalid_profile");
        let mut no_name = custom("mine");
        no_name.name = " ".into();
        assert_eq!(code(p.put(no_name)), "invalid_profile");

        for name in ["A=B", "", "A\0B"] {
            let mut c = custom("mine");
            c.env = vec![EnvVar {
                name: name.into(),
                value: "1".into(),
            }];
            assert_eq!(code(p.put(c)), "invalid_profile", "{name:?}");
        }
        let mut ok = custom("mine");
        ok.env = vec![EnvVar {
            name: "A_B".into(),
            value: "x=y".into(),
        }];
        p.put(ok).unwrap();
        assert_eq!(p.get("mine").unwrap().env[0].value, "x=y");
    }

    #[test]
    fn put_checks_the_effort_against_the_cli() {
        let mut p = Profiles::default();
        fn with_effort(p: &Profiles, id: &str, effort: &str) -> Profile {
            let mut profile = p.get(id).cloned().unwrap_or_else(|| custom(id));
            profile.effort = Some(effort.into());
            profile
        }
        for (id, effort) in [
            ("claude", "xhigh"),
            ("claude", "max"),
            ("codex", "low"),
            ("codex", "high"),
        ] {
            let profile = with_effort(&p, id, effort);
            p.put(profile).unwrap();
        }
        for (id, effort) in [
            ("claude", "extreme"),
            ("claude", ""),
            ("codex", "xhigh"),
            ("gemini", "low"),
            ("aider", "low"),
        ] {
            let profile = with_effort(&p, id, effort);
            assert_eq!(code(p.put(profile)), "invalid_profile", "{id} {effort}");
        }
        // The rejected ones changed nothing.
        assert_eq!(p.get("claude").unwrap().effort.as_deref(), Some("max"));
        assert_eq!(p.get("gemini").unwrap().effort, None);
        assert!(p.get("mine").is_none());
    }

    #[test]
    fn put_pins_the_cli() {
        let mut p = Profiles::default();
        // A built-in keeps its CLI whatever the caller sends.
        let mut codex = p.get("codex").unwrap().clone();
        codex.cli = Some(Cli::Gemini);
        codex.model = Some("m".into());
        p.put(codex).unwrap();
        assert_eq!(p.get("codex").unwrap().cli, Some(Cli::Codex));
        assert_eq!(p.get("codex").unwrap().model.as_deref(), Some("m"));
        let mut cleared = p.get("codex").unwrap().clone();
        cleared.cli = None;
        p.put(cleared).unwrap();
        assert_eq!(p.get("codex").unwrap().cli, Some(Cli::Codex));
        // A custom profile cannot take one.
        let mut c = custom("mine");
        c.cli = Some(Cli::Claude);
        assert_eq!(code(p.put(c)), "invalid_profile");
        // Replacing keeps the list order.
        assert_eq!(ids(&p), CLI_IDS);
    }

    #[test]
    fn reset_clears_overrides() {
        let mut p = Profiles::default();
        let mut c = p.get("claude").unwrap().clone();
        c.args = vec!["--verbose".into()];
        c.env = vec![EnvVar {
            name: "A".into(),
            value: "1".into(),
        }];
        c.model = Some("opus".into());
        c.effort = Some("high".into());
        c.account = Some("work".into());
        c.startup = vec!["cd src".into()];
        c.permissions = Some(Permissions::Skip);
        p.put(c).unwrap();
        p.reset("claude").unwrap();
        let c = p.get("claude").unwrap();
        assert!(c.args.is_empty() && c.env.is_empty());
        assert_eq!(c.permissions, None);
        assert_eq!(c.model.as_deref(), Some("opus"));
        assert_eq!(c.effort.as_deref(), Some("high"));
        assert_eq!(c.account.as_deref(), Some("work"));
        assert_eq!(c.startup, ["cd src"]);
        assert_eq!(code(p.reset("nope")), "unknown_profile");
    }

    #[test]
    fn reset_leaves_a_custom_profile_alone() {
        let mut p = Profiles::default();
        let mut c = custom("mine");
        c.args = vec!["--yes".into()];
        c.env = vec![EnvVar {
            name: "A".into(),
            value: "1".into(),
        }];
        c.permissions = Some(Permissions::AcceptEdits);
        p.put(c.clone()).unwrap();
        p.reset("aider").unwrap();
        assert_eq!(p.get("mine"), Some(&c));
    }

    #[test]
    fn enabled_defaults_to_true() {
        let d = tempdir();
        fs::write(
            d.path().join(FILE),
            r#"{"version":1,"defaultAgent":"claude","profiles":[
                {"id":"mine","name":"Mine","program":"mine"}]}"#,
        )
        .unwrap();
        let p = Profiles::load(d.path()).unwrap();
        assert!(p.get("mine").unwrap().enabled);
    }

    #[test]
    fn missing_default_agent_is_claude() {
        let d = tempdir();
        fs::write(d.path().join(FILE), r#"{"version":1}"#).unwrap();
        let p = Profiles::load(d.path()).unwrap();
        assert_eq!(p.default_agent, DefaultAgent::Auto);
        assert_eq!(ids(&p), CLI_IDS);
    }

    #[test]
    fn custom_id_clash_is_renamed() {
        let d = tempdir();
        fs::write(
            d.path().join(FILE),
            r#"{"version":1,"defaultAgent":"aider","profiles":[
              {"id":"aider","name":"My aider","program":"aider-x","args":["-v"]},
              {"id":"aider-custom","name":"Other","program":"o"}]}"#,
        )
        .unwrap();
        let p = Profiles::load(d.path()).unwrap();
        // The built-in aider is back, the stored one is kept under a free id.
        assert!(p.get("aider").unwrap().cli.is_some());
        let moved = p.get("aider-custom-2").unwrap();
        assert_eq!(moved.program.as_deref(), Some("aider-x"));
        assert_eq!(moved.args, ["-v"]);
        assert!(p.get("aider-custom").unwrap().cli.is_none());
        assert_eq!(
            p.default_agent,
            DefaultAgent::Agent("aider-custom-2".into())
        );
    }

    #[test]
    fn old_default_string_reads_as_agent() {
        let d = tempdir();
        fs::write(
            d.path().join(FILE),
            r#"{"version":1,"defaultAgent":"codex"}"#,
        )
        .unwrap();
        let p = Profiles::load(d.path()).unwrap();
        assert_eq!(p.default_agent, DefaultAgent::Agent("codex".into()));
    }

    #[test]
    fn default_auto_by_default() {
        assert_eq!(Profiles::default().default_agent, DefaultAgent::Auto);
    }

    #[test]
    fn failed_save_leaves_no_temp_file() {
        let d = tempdir();
        // A folder where the file belongs makes the final rename fail.
        fs::create_dir(d.path().join(FILE)).unwrap();
        assert_eq!(code(Profiles::default().save(d.path())), "io");
        let names: Vec<_> = fs::read_dir(d.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, ["profiles.json"]);
    }

    #[test]
    fn follows_approvals_until_overridden() {
        let mut p = Profiles {
            approvals: Approvals::Skip,
            ..Profiles::default()
        };
        assert_eq!(p.effective(p.get("claude").unwrap()), Permissions::Skip);
        // Args opt out; without a mode of its own it asks.
        let mut c = p.get("claude").unwrap().clone();
        c.args = vec!["--verbose".into()];
        p.put(c).unwrap();
        assert!(!p.get("claude").unwrap().follows_approvals());
        assert_eq!(p.effective(p.get("claude").unwrap()), Permissions::Ask);
        // Reset follows the switch again.
        p.reset("claude").unwrap();
        assert_eq!(p.effective(p.get("claude").unwrap()), Permissions::Skip);
        // A mode of its own opts out; Reset takes it back.
        let mut m = p.get("claude").unwrap().clone();
        m.permissions = Some(Permissions::AcceptEdits);
        p.put(m).unwrap();
        assert_eq!(
            p.effective(p.get("claude").unwrap()),
            Permissions::AcceptEdits
        );
        p.reset("claude").unwrap();
        assert!(p.get("claude").unwrap().follows_approvals());
        assert_eq!(p.effective(p.get("claude").unwrap()), Permissions::Skip);
        // Env opts out too.
        let mut x = p.get("codex").unwrap().clone();
        x.env = vec![EnvVar {
            name: "A".into(),
            value: "1".into(),
        }];
        p.put(x).unwrap();
        assert_eq!(p.effective(p.get("codex").unwrap()), Permissions::Ask);
        // A mode of its own wins over the switch.
        let mut g = p.get("gemini").unwrap().clone();
        g.permissions = Some(Permissions::AcceptEdits);
        p.put(g).unwrap();
        assert_eq!(
            p.effective(p.get("gemini").unwrap()),
            Permissions::AcceptEdits
        );
        // A custom profile asks even when the switch is skip.
        p.put(custom("mine")).unwrap();
        assert!(!p.get("mine").unwrap().follows_approvals());
        assert_eq!(p.effective(p.get("mine").unwrap()), Permissions::Ask);
        let mut skipping = custom("mine");
        skipping.permissions = Some(Permissions::Skip);
        p.put(skipping).unwrap();
        assert_eq!(p.effective(p.get("mine").unwrap()), Permissions::Ask);
    }

    #[test]
    fn default_agent_must_exist() {
        let mut p = Profiles::default();
        let err = p.set_defaults(Approvals::Skip, DefaultAgent::Agent("nope".into()), None);
        assert_eq!(code(err), "unknown_profile");
        // Nothing changed.
        assert_eq!(p.approvals, Approvals::Ask);
        assert_eq!(p.default_agent, DefaultAgent::Auto);
        p.set_defaults(
            Approvals::Skip,
            DefaultAgent::Agent("gemini".into()),
            Some("cmd".into()),
        )
        .unwrap();
        assert_eq!(p.default_agent, DefaultAgent::Agent("gemini".into()));
        assert_eq!(p.default_shell.as_deref(), Some("cmd"));
    }

    #[test]
    fn removing_the_default_agent_resets_it() {
        let mut p = Profiles::default();
        p.put(custom("mine")).unwrap();
        p.set_defaults(Approvals::Ask, DefaultAgent::Agent("mine".into()), None)
            .unwrap();
        p.remove("mine").unwrap();
        assert_eq!(p.default_agent, DefaultAgent::Auto);
        assert!(p.get("mine").is_none());
    }

    #[test]
    fn disabling_default_resets_to_auto() {
        let mut p = Profiles::default();
        p.set_defaults(Approvals::Ask, DefaultAgent::Agent("codex".into()), None)
            .unwrap();
        let mut c = p.get("codex").unwrap().clone();
        c.enabled = false;
        p.put(c).unwrap();
        assert_eq!(p.default_agent, DefaultAgent::Auto);
    }

    #[test]
    fn shells_are_put_and_removed() {
        let mut p = Profiles::default();
        let fish = CustomShell {
            id: "fish".into(),
            name: "Fish".into(),
            program: "fish".into(),
            args: Vec::new(),
        };
        p.put_shell(fish.clone()).unwrap();
        let mut again = fish.clone();
        again.args = vec!["-l".into()];
        p.put_shell(again.clone()).unwrap();
        assert_eq!(p.shells, [again]);
        for id in ["", "shell", "powershell", "cmd", "login", "Fish", "a:b"] {
            let mut bad = fish.clone();
            bad.id = id.into();
            assert_eq!(code(p.put_shell(bad)), "invalid_profile", "{id}");
        }
        let mut no_program = fish.clone();
        no_program.program = " ".into();
        assert_eq!(code(p.put_shell(no_program)), "invalid_profile");

        p.set_defaults(
            Approvals::Ask,
            DefaultAgent::Agent("claude".into()),
            Some("fish".into()),
        )
        .unwrap();
        p.remove_shell("fish").unwrap();
        assert!(p.shells.is_empty());
        assert_eq!(p.default_shell, None);
        assert_eq!(code(p.remove_shell("fish")), "unknown_profile");
    }
}
