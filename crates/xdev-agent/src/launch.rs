//! What a terminal runs: the user's shell or an agent CLI, by profile id.

use std::env;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use xdev_ai::{AiError, Provider, Registry, codex_home};

use crate::catalog::{PromptMode, has_permission_args, permission_env, prompt_args, spec};
use crate::codex_home::{codex_hook_events, prepare_codex_home};
use crate::flags::{efforts, flags};
use crate::hooks::{HookEvent, hook_args, hook_events};
use crate::profiles::{Cli, Permissions, Profile, ProfileError, Profiles};
use crate::shells::{ShellEntry, default_shell_id};
use crate::version::{CliVersion, cli_version};

/// Where a launch's account came from: the tab's own pick, the profile's
/// account, the provider's active (default) account, or the provider's
/// routing, which the caller applies by passing the routed account and
/// marking it so.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum AccountSource {
    Tab,
    Profile,
    Active,
    Routed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub profile: String,
    pub program: PathBuf,
    /// The mapped flags, then the profile's own args.
    pub args: Vec<String>,
    pub env: Vec<(String, OsString)>,
    /// An agent launch goes through the policy gate; a shell does not.
    pub agent: bool,
    /// The mode the flags in `args` stand for.
    pub permissions: Permissions,
    /// The account the CLI runs as, when it has one.
    pub account: Option<String>,
    /// Where `account` came from; `None` when there is no account.
    pub account_source: Option<AccountSource>,
    /// Shell lines to run before the CLI; see `command`.
    pub startup: Vec<String>,
    /// The built-in CLI the profile runs; `None` for shells and custom
    /// programs.
    pub cli: Option<Cli>,
    /// Whether `args` carry the status hook flags (`add_hooks`).
    pub hooks: bool,
    /// The hook events the launch reports, each once; empty without hooks.
    /// A codex on its private home reports more than on `notify` alone.
    pub hook_events: Vec<HookEvent>,
    /// A first prompt the terminal types once the agent has started: the
    /// agent takes none on its command line, or the program is a Windows
    /// shim that must not get it as an argument. Never part of the policy
    /// fingerprint.
    pub prompt_after: Option<String>,
    /// The first prompt as arguments, for agents that take it on the command
    /// line. `command` puts them last; they are not in `args`, so the policy
    /// fingerprint ignores them.
    pub prompt_argv: Vec<String>,
}

impl Launch {
    /// Appends the status hook flags for `cli` that run `xdev`, after the
    /// mapped flags and the profile's args and before any startup wrapping,
    /// so the policy gate and the fingerprint see them. A shell, a custom
    /// program or a CLI without hooks is left as it is.
    ///
    /// The CLI is asked for its version first (once per program path), so
    /// it gets only the hook events it knows. A codex new enough also gets
    /// its private home under `data_dir` (`CODEX_HOME`, see `codex_home`).
    pub fn add_hooks(&mut self, xdev: &Path, data_dir: &Path) {
        let asks = matches!(self.cli, Some(Cli::Claude | Cli::Codex));
        if asks && self.agent && !self.hooks {
            let version = cli_version(&self.program);
            self.add_hooks_with(xdev, Some(data_dir), version);
        }
    }

    /// `add_hooks` for a CLI that reported `version` (`None`: unknown).
    /// Without `data_dir`, codex gets `notify` only.
    pub fn add_hooks_with(
        &mut self,
        xdev: &Path,
        data_dir: Option<&Path>,
        version: Option<CliVersion>,
    ) {
        let Some(cli) = self.cli.filter(|_| self.agent && !self.hooks) else {
            return;
        };
        let flags = hook_args(cli, xdev, version);
        if flags.is_empty() {
            return;
        }
        // `notify` stays on with the private home: it still reports the end
        // of a turn if codex skips the hooks (say, an unmatched trust hash);
        // `xdev agent-hook` drops it when `Stop` already did.
        self.args.extend(flags);
        self.hooks = true;
        self.hook_events = hook_events(cli, version);
        if cli == Cli::Codex
            && let (Some(data_dir), Some(version)) = (data_dir, version)
        {
            self.use_codex_home(xdev, data_dir, version);
        }
    }

    /// Points `CODEX_HOME` at the private home, built from the home the CLI
    /// would use (the account's, the profile's `CODEX_HOME`, else the
    /// default). Any failure leaves the launch on its own home.
    fn use_codex_home(&mut self, xdev: &Path, data_dir: &Path, version: CliVersion) {
        let var = Provider::Codex.home_var();
        let is_var = |key: &str| {
            if cfg!(windows) {
                key.eq_ignore_ascii_case(var)
            } else {
                key == var
            }
        };
        let set = self
            .env
            .iter()
            .rev()
            .find(|(key, _)| is_var(key))
            .map(|(_, dir)| PathBuf::from(dir));
        let Some(real) = set.or_else(|| codex_home(None)) else {
            return;
        };
        let account = self.account.as_deref();
        let Ok(home) = prepare_codex_home(data_dir, account, &real, xdev, version) else {
            return;
        };
        self.env.retain(|(key, _)| !is_var(key));
        self.env.push((var.to_owned(), home.into_os_string()));
        self.hook_events = codex_hook_events(version);
    }

    /// What to spawn: `program` and `args` as they are, or, with startup
    /// lines, a shell that runs the lines and then the CLI. The wrapper
    /// quotes the CLI's program and args, so each stays one argument.
    pub fn command(&self) -> (PathBuf, Vec<String>) {
        let mut args = self.args.clone();
        args.extend(self.prompt_argv.iter().cloned());
        if self.startup.is_empty() {
            return (self.program.clone(), args);
        }
        let program = self.program.to_string_lossy();
        if cfg!(windows) {
            wrap_powershell(&self.startup, &program, &args)
        } else {
            let shell = env::var_os("SHELL")
                .filter(|s| !s.is_empty())
                .map_or_else(|| PathBuf::from("/bin/sh"), PathBuf::from);
            wrap_posix(&shell, &self.startup, &program, &args)
        }
    }
}

/// What one launch changes on its profile: the model, the effort and extra
/// arguments. A blank field leaves the profile as it is. Nothing is stored.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(default, rename_all = "camelCase")]
pub struct LaunchOverrides {
    pub model: Option<String>,
    pub effort: Option<String>,
    /// Appended after every other argument, one word each.
    pub extra_args: Vec<String>,
}

/// The longest model name, effort or extra argument a launch takes, and the
/// most extra arguments.
pub const OVERRIDE_TEXT_MAX: usize = 200;
pub const OVERRIDE_ARGS_MAX: usize = 32;

impl LaunchOverrides {
    /// The overrides with blanks dropped, texts trimmed and cut to
    /// `OVERRIDE_TEXT_MAX` chars, and at most `OVERRIDE_ARGS_MAX` extra
    /// arguments. A control character in any text drops that text.
    pub fn clamped(&self) -> LaunchOverrides {
        let clean = |text: &str| {
            let text = text.trim();
            (!text.is_empty() && !text.chars().any(char::is_control))
                .then(|| text.chars().take(OVERRIDE_TEXT_MAX).collect::<String>())
        };
        LaunchOverrides {
            model: self.model.as_deref().and_then(clean),
            effort: self.effort.as_deref().and_then(clean),
            extra_args: self
                .extra_args
                .iter()
                .filter_map(|a| clean(a))
                .take(OVERRIDE_ARGS_MAX)
                .collect(),
        }
    }

    pub fn is_empty(&self) -> bool {
        let c = self.clamped();
        c.model.is_none() && c.effort.is_none() && c.extra_args.is_empty()
    }
}

/// The model flag and its value as `args` carries them, removed. Handles
/// `--model x`, `--model=x` and, for CLIs that use it, `-m x`.
fn strip_option(args: &mut Vec<String>, names: &[&str]) {
    let mut i = 0;
    while i < args.len() {
        let hit = names.iter().any(|n| {
            args[i] == *n || (n.starts_with("--") && args[i].starts_with(&format!("{n}=")))
        });
        if hit && !args[i].contains('=') && i + 1 < args.len() {
            args.drain(i..=i + 1);
        } else if hit {
            args.remove(i);
        } else {
            i += 1;
        }
    }
}

/// `args` for `cli` with the launch's overrides applied: a model or effort
/// replaces the profile's (no flag is left twice), blank keeps the profile's,
/// and the extra arguments go last.
pub fn apply_overrides(cli: Option<Cli>, args: &mut Vec<String>, overrides: &LaunchOverrides) {
    let o = overrides.clamped();
    if let Some(cli) = cli {
        // After a codex subcommand (`resume <id>`), where its options start.
        let at = if cli == Cli::Codex
            && matches!(args.first().map(String::as_str), Some("resume" | "fork"))
        {
            2.min(args.len())
        } else {
            0
        };
        let mut head: Vec<String> = Vec::new();
        if let Some(model) = &o.model {
            strip_option(
                args,
                if cli == Cli::Claude {
                    &["--model"]
                } else {
                    &["--model", "-m"]
                },
            );
            head.extend(flags(cli, Some(model), None, Permissions::Ask));
        }
        if let Some(effort) = o.effort.as_deref().filter(|_| !efforts(cli).is_empty()) {
            if cli == Cli::Claude {
                strip_option(args, &["--effort"]);
            } else {
                // codex: `-c model_reasoning_effort=<x>` pair
                let mut i = 0;
                while i + 1 < args.len() {
                    if args[i] == "-c" && args[i + 1].starts_with("model_reasoning_effort=") {
                        args.drain(i..=i + 1);
                    } else {
                        i += 1;
                    }
                }
            }
            head.extend(flags(cli, None, Some(effort), Permissions::Ask));
        }
        let at = at.min(args.len());
        args.splice(at..at, head);
    }
    args.extend(o.extra_args);
}

impl Launch {
    /// Applies a launch's overrides to `args`; see `apply_overrides`. A shell
    /// takes none.
    pub fn apply_overrides(&mut self, overrides: &LaunchOverrides) {
        if self.agent {
            apply_overrides(self.cli, &mut self.args, overrides);
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum LaunchError {
    #[error("unknown profile")]
    UnknownProfile,
    /// Carries the CLI's `AiError` code.
    #[error("agent CLI is not installed ({0})")]
    NotInstalled(&'static str),
    /// The program that could not be found; also the error's detail.
    #[error("{0}")]
    NotFound(String),
    #[error("the profile is disabled")]
    Off,
    #[error("no account with this name for this agent")]
    UnknownAccount,
    #[error(transparent)]
    Profiles(#[from] ProfileError),
}

impl LaunchError {
    pub fn code(&self) -> &'static str {
        match self {
            LaunchError::UnknownProfile => "unknown_profile",
            LaunchError::NotInstalled(code) => code,
            LaunchError::NotFound(_) => "not_installed",
            LaunchError::Off => "profile_off",
            LaunchError::UnknownAccount => "unknown_account",
            LaunchError::Profiles(e) => e.code(),
        }
    }
}

/// What `resolve` reads: the stores and how to find a program.
pub struct Context<'a> {
    pub profiles: &'a Profiles,
    pub accounts: &'a Registry,
    /// The shells on offer (`list_shells`), for the `shell` ids.
    pub shells: &'a [ShellEntry],
    /// The program of a profile, or `None` when it is not installed.
    pub find: &'a dyn Fn(&Profile) -> Option<PathBuf>,
    /// An account that replaces the profile's own (a restart keeps the
    /// tab's account).
    pub account: Option<&'a str>,
    /// A first prompt for the agent; see `Launch::prompt_after`.
    pub prompt: Option<&'a str>,
}

/// The launch of the agent profile or shell `id`: `shell` (the default
/// shell), `shell:<shell id>` or a profile id.
pub fn resolve(id: &str, ctx: &Context) -> Result<Launch, LaunchError> {
    if id == "shell" || id.starts_with("shell:") {
        return resolve_shell(id, ctx);
    }
    let profile = ctx.profiles.get(id).ok_or(LaunchError::UnknownProfile)?;
    if !profile.enabled {
        return Err(LaunchError::Off);
    }
    let program = (ctx.find)(profile).ok_or_else(|| match profile.cli {
        Some(Cli::Claude) => LaunchError::NotInstalled(AiError::NoClaude.code()),
        Some(Cli::Codex) => LaunchError::NotInstalled(AiError::NoCodex.code()),
        Some(cli) => LaunchError::NotFound(cli.as_str().to_owned()),
        None => LaunchError::NotFound(profile.program.clone().unwrap_or_default()),
    })?;

    // Permission flags of the person's own args replace xDev's, so xDev
    // adds no mode and the gate has none to approve.
    let permissions = match profile.cli {
        Some(cli) if has_permission_args(cli, &profile.args) => Permissions::Ask,
        _ => ctx.profiles.effective(profile),
    };
    let mut args = match profile.cli {
        Some(cli) => flags(
            cli,
            profile.model.as_deref(),
            profile.effort.as_deref(),
            permissions,
        ),
        None => Vec::new(),
    };
    args.extend(profile.args.iter().cloned());
    let startup: Vec<String> = profile
        .startup
        .iter()
        .map(|line| line.trim().to_owned())
        .filter(|line| !line.is_empty())
        .collect();
    let (prompt_argv, prompt_after) = place_prompt(
        profile.cli,
        &program,
        ctx.prompt,
        cfg!(windows),
        !startup.is_empty(),
    );

    let mut env: Vec<(String, OsString)> = profile
        .env
        .iter()
        .map(|e| (e.name.clone(), OsString::from(&e.value)))
        .collect();
    if let Some(cli) = profile.cli {
        for (name, value) in permission_env(cli, permissions) {
            if !env.iter().any(|(key, _)| key == name) {
                env.push(((*name).to_owned(), OsString::from(value)));
            }
        }
    }
    let provider = match profile.cli {
        Some(Cli::Claude) => Some(Provider::Claude),
        Some(Cli::Codex) => Some(Provider::Codex),
        _ => None,
    };
    // The tab's account, else the profile's own, else the provider's active
    // one. A profile with no provider has no home to switch, so it ignores
    // the active account (R1: a profile's own account never follows it).
    let picked = ctx
        .account
        .map(|name| (name, AccountSource::Tab))
        .or_else(|| {
            profile
                .account
                .as_deref()
                .map(|name| (name, AccountSource::Profile))
        })
        .or_else(|| {
            let active = ctx.accounts.active(provider?)?;
            Some((active.name.as_str(), AccountSource::Active))
        });
    let account = picked.map(|(name, _)| name);
    let account_source = picked.map(|(_, source)| source);
    if let Some(name) = account {
        let provider = provider.ok_or(LaunchError::UnknownAccount)?;
        let entry = ctx
            .accounts
            .get(name)
            .filter(|a| a.provider == provider)
            .ok_or(LaunchError::UnknownAccount)?;
        // The account's folder wins over a variable of the same name.
        let var = provider.home_var();
        // Variable names are case-insensitive on Windows only.
        env.retain(|(key, _)| {
            if cfg!(windows) {
                !key.eq_ignore_ascii_case(var)
            } else {
                key != var
            }
        });
        env.push((var.to_owned(), entry.dir.clone().into_os_string()));
    }

    Ok(Launch {
        profile: profile.id.clone(),
        program,
        args,
        env,
        agent: true,
        permissions,
        account: account.map(str::to_owned),
        account_source,
        startup,
        cli: profile.cli,
        hooks: false,
        hook_events: Vec::new(),
        prompt_after,
        prompt_argv,
    })
}

/// Splits `prompt` into the arguments that carry it (agents that take it on
/// their command line) and the text to type once the agent has started
/// (after-start agents, custom programs, a Windows `.cmd`/`.bat` shim, and a
/// prompt an argument parser would read as a flag).
///
/// On Windows the prompt is never an argument when startup lines wrap the
/// CLI (`wrapped`) or when it holds a `"`: PowerShell re-quotes arguments
/// itself and can split one (see `native_arg`), so a prompt could add flags
/// the policy gate never saw.
fn place_prompt(
    cli: Option<Cli>,
    program: &Path,
    prompt: Option<&str>,
    windows: bool,
    wrapped: bool,
) -> (Vec<String>, Option<String>) {
    let Some(prompt) = prompt.filter(|p| !p.trim().is_empty()) else {
        return (Vec::new(), None);
    };
    let typed = || (Vec::new(), Some(prompt.to_owned()));
    let Some(cli) = cli else {
        return typed();
    };
    let line = prompt_args(cli, prompt);
    let shim = windows
        && program
            .extension()
            .and_then(OsStr::to_str)
            .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
    // After `--` a leading dash is text; as a bare argument or a flag's
    // value a parser may read it as a flag.
    let flag_like = matches!(spec(cli).prompt, PromptMode::Argv | PromptMode::Flag(_))
        && prompt.starts_with('-');
    let requoted = windows && (wrapped || prompt.contains('"'));
    if line.is_empty() || shim || flag_like || requoted {
        return typed();
    }
    (line, None)
}

/// A shell is never an agent: no policy gate, no account, no startup lines.
fn resolve_shell(id: &str, ctx: &Context) -> Result<Launch, LaunchError> {
    let shell_id = match id.strip_prefix("shell:") {
        Some(shell_id) => shell_id.to_owned(),
        None => default_shell_id(ctx.profiles, ctx.shells),
    };
    let entry = ctx
        .shells
        .iter()
        .find(|s| s.id == shell_id)
        .ok_or(LaunchError::UnknownProfile)?;
    Ok(Launch {
        profile: id.to_owned(),
        program: entry.program.clone(),
        args: entry.args.clone(),
        env: Vec::new(),
        agent: false,
        permissions: Permissions::Ask,
        account: None,
        account_source: None,
        startup: Vec::new(),
        cli: None,
        hooks: false,
        hook_events: Vec::new(),
        prompt_after: None,
        prompt_argv: Vec::new(),
    })
}

/// Windows PowerShell running `lines`, then the program with its args, and
/// exiting with the program's code (1 when the program never started). The
/// script travels as base64 of UTF-16LE so no layer of command-line quoting
/// touches it.
fn wrap_powershell(lines: &[String], program: &str, args: &[String]) -> (PathBuf, Vec<String>) {
    let mut script = lines.join("; ");
    script.push_str("; & ");
    script.push_str(&ps_quote(program));
    for arg in args {
        script.push(' ');
        script.push_str(&ps_quote(&native_arg(arg)));
    }
    script.push_str("; exit $(if ($null -eq $LASTEXITCODE) { 1 } else { $LASTEXITCODE })");
    let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let args = ["-NoLogo", "-NoProfile", "-EncodedCommand"]
        .map(str::to_owned)
        .into_iter()
        .chain([base64(&utf16)])
        .collect();
    (PathBuf::from("powershell.exe"), args)
}

/// An argument as Windows PowerShell 5.1 must be given it so the program
/// parses it back unchanged. PowerShell wraps most arguments with whitespace in
/// double quotes and otherwise passes it as it is, without escaping any
/// embedded `"`; so escape `"` as `\"`, double the backslashes before each
/// `"` (and a trailing run, which would meet the closing quote), and write an
/// empty argument as `""`.
///
/// Known gap, seen on 5.1: PowerShell decides itself whether to wrap, and an
/// argument whose whitespace follows an odd number of quotes (`"a b"`) is
/// passed unwrapped, so the program sees two arguments. `place_prompt`
/// keeps a prompt out of it.
fn native_arg(text: &str) -> String {
    if text.is_empty() {
        return "\"\"".to_owned();
    }
    let wrapped = text.contains(char::is_whitespace);
    let mut out = String::with_capacity(text.len());
    let mut slashes = 0;
    for c in text.chars() {
        match c {
            '\\' => {
                slashes += 1;
                out.push(c);
            }
            '"' => {
                out.extend(std::iter::repeat_n('\\', slashes + 1));
                out.push(c);
                slashes = 0;
            }
            _ => {
                slashes = 0;
                out.push(c);
            }
        }
    }
    if wrapped {
        out.extend(std::iter::repeat_n('\\', slashes));
    }
    out
}

/// Single-quoted. PowerShell also reads the typographic single quotes as
/// quotes; in each of them a doubled quote is a literal one.
fn ps_quote(text: &str) -> String {
    let mut out = String::from("'");
    for c in text.chars() {
        out.push(c);
        if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}') {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// `shell -l -c` running `lines`, then replacing itself with the program.
fn wrap_posix(
    shell: &Path,
    lines: &[String],
    program: &str,
    args: &[String],
) -> (PathBuf, Vec<String>) {
    let mut script = lines.join("\n");
    script.push_str("\nexec ");
    script.push_str(&sh_quote(program));
    for arg in args {
        script.push(' ');
        script.push_str(&sh_quote(arg));
    }
    (
        shell.to_path_buf(),
        vec!["-l".to_owned(), "-c".to_owned(), script],
    )
}

fn sh_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

/// RFC 4648 base64 with padding.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, b)| n | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(char::from(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles::{Approvals, EnvVar, builtin};
    use crate::shells::ShellKind;

    // --- resolve ---

    fn custom(id: &str) -> Profile {
        Profile {
            id: id.to_owned(),
            name: "Aider".to_owned(),
            cli: None,
            program: Some("aider".to_owned()),
            ..builtin(Cli::Claude)
        }
    }

    fn accounts() -> Registry {
        let mut r = Registry::default();
        r.add("work", Provider::Claude, PathBuf::from("D")).unwrap();
        r.add("gpt", Provider::Codex, PathBuf::from("E")).unwrap();
        r
    }

    fn found(_: &Profile) -> Option<PathBuf> {
        Some(PathBuf::from("/bin/agent"))
    }

    fn run(
        profiles: &Profiles,
        id: &str,
        account: Option<&str>,
        find: &dyn Fn(&Profile) -> Option<PathBuf>,
    ) -> Result<Launch, LaunchError> {
        let accounts = accounts();
        resolve(
            id,
            &Context {
                profiles,
                accounts: &accounts,
                shells: &[],
                find,
                account,
                prompt: None,
            },
        )
    }

    fn with(profile: Profile) -> Profiles {
        let mut p = Profiles::default();
        p.put(profile).unwrap();
        p
    }

    #[test]
    fn resolve_puts_mapped_flags_before_args() {
        let mut c = builtin(Cli::Claude);
        c.model = Some("m".into());
        c.args = vec!["--verbose".into()];
        let l = run(&with(c), "claude", None, &found).unwrap();
        assert_eq!(l.args, ["--model", "m", "--verbose"]);
        assert_eq!(l.program, PathBuf::from("/bin/agent"));
        assert!(l.agent);
        assert_eq!(l.profile, "claude");
        // Args opt out of the global switch, so no mode flag.
        assert_eq!(l.permissions, Permissions::Ask);
    }

    #[test]
    fn own_permission_args_launch_as_ask() {
        let mut c = builtin(Cli::Claude);
        c.permissions = Some(Permissions::Skip);
        c.args = vec!["--permission-mode".into(), "plan".into()];
        let l = run(&with(c), "claude", None, &found).unwrap();
        assert_eq!(l.args, ["--permission-mode", "plan"]);
        // xDev adds no mode, so the gate has none to approve.
        assert_eq!(l.permissions, Permissions::Ask);
    }

    fn run_prompt(profiles: &Profiles, id: &str, program: &str, prompt: &str) -> Launch {
        let accounts = accounts();
        let find = |_: &Profile| Some(PathBuf::from(program));
        resolve(
            id,
            &Context {
                profiles,
                accounts: &accounts,
                shells: &[],
                find: &find,
                account: None,
                prompt: Some(prompt),
            },
        )
        .unwrap()
    }

    #[test]
    fn prompt_goes_in_argv_per_mode() {
        let p = Profiles::default();
        let l = run_prompt(&p, "claude", "/bin/claude", "fix it");
        assert_eq!(l.prompt_argv, ["fix it"]);
        assert_eq!(l.command().1, ["fix it"]);
        assert!(l.args.is_empty());
        assert_eq!(l.prompt_after, None);
        let l = run_prompt(&p, "devin", "/bin/devin", "fix it");
        assert_eq!(l.prompt_argv, ["--", "fix it"]);
        let l = run_prompt(&p, "gemini", "/bin/gemini", "fix it");
        assert_eq!(l.prompt_argv, ["--prompt-interactive", "fix it"]);
        // After-start agents and custom programs get it typed.
        let l = run_prompt(&p, "aider", "/bin/aider", "fix it");
        assert!(l.args.is_empty());
        assert_eq!(l.prompt_after.as_deref(), Some("fix it"));
        let l = run_prompt(&with(custom("mine")), "mine", "/bin/x", "fix it");
        assert_eq!(l.prompt_after.as_deref(), Some("fix it"));
        // A prompt that looks like a flag is typed, not passed.
        let l = run_prompt(&p, "claude", "/bin/claude", "--help me");
        assert!(l.args.is_empty());
        assert_eq!(l.prompt_after.as_deref(), Some("--help me"));
        // Also as a flag's value; after `--` it is text.
        for id in ["gemini", "copilot", "opencode"] {
            let l = run_prompt(&p, id, &format!("/bin/{id}"), "--yolo");
            assert!(l.prompt_argv.is_empty(), "{id}");
            assert_eq!(l.prompt_after.as_deref(), Some("--yolo"), "{id}");
        }
        let l = run_prompt(&p, "devin", "/bin/devin", "--yolo");
        assert_eq!(l.prompt_argv, ["--", "--yolo"]);
        // A blank prompt is no prompt.
        let l = run_prompt(&p, "claude", "/bin/claude", "  ");
        assert!(l.prompt_argv.is_empty() && l.prompt_after.is_none());
    }

    #[test]
    fn prompt_is_not_in_the_fingerprint_input() {
        // The fingerprint reads `args`, `program` and the mode; the prompt is
        // in `prompt_argv`, so a launch with it is the same approved agent.
        let p = Profiles::default();
        let with_prompt = run_prompt(&p, "claude", "/bin/found", "x");
        let without = run(&p, "claude", None, &|_| Some(PathBuf::from("/bin/found"))).unwrap();
        assert_eq!(with_prompt.args, without.args);
        assert_eq!(with_prompt.program, without.program);
        assert_eq!(with_prompt.permissions, without.permissions);
    }

    const INJECTED: &str = "x\" --dangerously-skip-permissions \"y";

    #[test]
    fn a_quoted_prompt_never_adds_a_flag_on_windows() {
        let exe = Path::new("C:/n/claude.exe");
        // Startup lines wrap the CLI in PowerShell: always typed.
        for prompt in [INJECTED, "fix it"] {
            let (argv, after) = place_prompt(Some(Cli::Claude), exe, Some(prompt), true, true);
            assert!(argv.is_empty(), "{prompt}");
            assert_eq!(after.as_deref(), Some(prompt));
        }
        // A direct spawn types a prompt that holds a quote.
        let (argv, after) = place_prompt(Some(Cli::Claude), exe, Some(INJECTED), true, false);
        assert!(argv.is_empty());
        assert_eq!(after.as_deref(), Some(INJECTED));
        let (argv, _) = place_prompt(Some(Cli::Claude), exe, Some("fix it"), true, false);
        assert_eq!(argv, ["fix it"]);
        // Elsewhere the prompt stays one argument, quotes and all.
        let bin = Path::new("/bin/claude");
        let (argv, _) = place_prompt(Some(Cli::Claude), bin, Some(INJECTED), false, true);
        assert_eq!(argv, [INJECTED]);
    }

    #[test]
    fn a_quoted_prompt_with_startup_is_never_its_own_flag() {
        let mut c = builtin(Cli::Claude);
        c.startup = vec!["cd src".into()];
        let p = with(c);
        let l = run_prompt(&p, "claude", "/bin/claude", INJECTED);
        let (_, args) = l.command();
        assert!(!args.iter().any(|a| a == "--dangerously-skip-permissions"));
        if cfg!(windows) {
            assert!(l.prompt_argv.is_empty());
            assert_eq!(l.prompt_after.as_deref(), Some(INJECTED));
            assert!(!decode_powershell(&args).contains("dangerously"));
        } else {
            assert_eq!(l.prompt_argv, [INJECTED]);
        }
        // Without startup lines the prompt is one whole argument, or typed.
        let l = run_prompt(&Profiles::default(), "claude", "/bin/claude", INJECTED);
        let (_, args) = l.command();
        assert!(!args.iter().any(|a| a == "--dangerously-skip-permissions"));
        assert!(l.prompt_argv.is_empty() || l.prompt_argv == [INJECTED]);
    }

    #[cfg(windows)]
    #[test]
    fn cmd_shim_gets_the_prompt_typed() {
        let p = Profiles::default();
        let l = run_prompt(&p, "claude", "C:/n/claude.cmd", "fix it");
        assert!(l.prompt_argv.is_empty());
        assert_eq!(l.prompt_after.as_deref(), Some("fix it"));
        let l = run_prompt(&p, "claude", "C:/n/claude.exe", "fix it");
        assert_eq!(l.prompt_argv, ["fix it"]);
    }

    #[test]
    fn resolve_own_permission_args_replace_the_mode() {
        let mut c = builtin(Cli::Claude);
        c.permissions = Some(Permissions::Skip);
        c.args = vec!["--permission-mode".into(), "plan".into()];
        let l = run(&with(c), "claude", None, &found).unwrap();
        assert_eq!(l.args, ["--permission-mode", "plan"]);
    }

    #[test]
    fn resolve_goose_skip_sets_env_not_args() {
        let p = Profiles {
            approvals: Approvals::Skip,
            ..Profiles::default()
        };
        let l = run(&p, "goose", None, &found).unwrap();
        assert_eq!(l.permissions, Permissions::Skip);
        assert!(l.args.is_empty());
        assert!(l.env.iter().any(|(k, v)| k == "GOOSE_MODE" && v == "auto"));
    }

    #[test]
    fn resolve_opencode_follows_skip_as_ask() {
        let p = Profiles {
            approvals: Approvals::Skip,
            ..Profiles::default()
        };
        let l = run(&p, "opencode", None, &found).unwrap();
        assert_eq!(l.permissions, Permissions::Ask);
        assert!(l.args.is_empty());
    }

    #[test]
    fn resolve_uses_the_effective_permissions() {
        let p = Profiles {
            approvals: Approvals::Skip,
            ..Profiles::default()
        };
        let l = run(&p, "claude", None, &found).unwrap();
        assert_eq!(l.permissions, Permissions::Skip);
        assert_eq!(l.args, ["--dangerously-skip-permissions"]);
        let l = run(&p, "gemini", None, &found).unwrap();
        assert_eq!(l.args, ["--approval-mode", "yolo"]);

        let mut x = builtin(Cli::Codex);
        x.permissions = Some(Permissions::AcceptEdits);
        let mut p = with(x);
        p.approvals = Approvals::Skip;
        let l = run(&p, "codex", None, &found).unwrap();
        assert_eq!(l.permissions, Permissions::AcceptEdits);
        assert_eq!(
            l.args,
            [
                "--sandbox",
                "workspace-write",
                "--ask-for-approval",
                "on-request"
            ]
        );
    }

    #[test]
    fn resolve_disabled_is_profile_off() {
        let mut c = builtin(Cli::Claude);
        c.enabled = false;
        let err = run(&with(c), "claude", None, &|_| panic!("detected")).unwrap_err();
        assert_eq!(err.code(), "profile_off");
    }

    #[test]
    fn resolve_unknown_is_unknown_profile() {
        let err = run(&Profiles::default(), "vim", None, &found).unwrap_err();
        assert_eq!(err.code(), "unknown_profile");
    }

    // --- shells ---

    fn entry(id: &str, kind: ShellKind) -> ShellEntry {
        ShellEntry {
            id: id.to_owned(),
            name: id.to_owned(),
            kind,
            program: PathBuf::from(format!("/sh/{id}")),
            args: vec!["-x".to_owned()],
        }
    }

    fn run_shell(profiles: &Profiles, id: &str) -> Result<Launch, LaunchError> {
        let shells = [
            entry("powershell", ShellKind::Powershell),
            entry("login", ShellKind::Login),
            entry("wsl:Ubuntu", ShellKind::Wsl),
            entry("fish", ShellKind::Custom),
        ];
        let accounts = accounts();
        resolve(
            id,
            &Context {
                profiles,
                accounts: &accounts,
                shells: &shells,
                find: &|_| panic!("a shell is not detected as a profile"),
                account: Some("work"),
                prompt: None,
            },
        )
    }

    #[test]
    fn resolve_named_shell_is_not_an_agent() {
        let l = run_shell(&Profiles::default(), "shell:wsl:Ubuntu").unwrap();
        assert_eq!(l.profile, "shell:wsl:Ubuntu");
        assert_eq!(l.program, PathBuf::from("/sh/wsl:Ubuntu"));
        assert_eq!(l.args, ["-x"]);
        assert!(!l.agent && l.env.is_empty() && l.startup.is_empty());
        assert_eq!(l.permissions, Permissions::Ask);
        // An account override for an agent tab never reaches a shell.
        assert_eq!(l.account, None);
        let l = run_shell(&Profiles::default(), "shell:fish").unwrap();
        assert_eq!(l.program, PathBuf::from("/sh/fish"));
    }

    #[test]
    fn resolve_shell_opens_the_default_shell() {
        let own = if cfg!(windows) { "powershell" } else { "login" };
        let mut p = Profiles::default();
        let l = run_shell(&p, "shell").unwrap();
        assert_eq!(l.profile, "shell");
        assert_eq!(l.program, PathBuf::from(format!("/sh/{own}")));
        assert!(!l.agent);

        p.default_shell = Some("fish".to_owned());
        assert_eq!(
            run_shell(&p, "shell").unwrap().program,
            PathBuf::from("/sh/fish")
        );
        // A default that is no longer listed falls back to the platform's.
        p.default_shell = Some("wsl:Gone".to_owned());
        assert_eq!(
            run_shell(&p, "shell").unwrap().program,
            PathBuf::from(format!("/sh/{own}"))
        );
    }

    #[test]
    fn resolve_unknown_shell_is_unknown_profile() {
        for id in ["shell:nope", "shell:", "shell:shell", "shell:wsl:Gone"] {
            let err = run_shell(&Profiles::default(), id).unwrap_err();
            assert_eq!(err.code(), "unknown_profile", "{id}");
        }
        // No shell is listed at all.
        let err = run(&Profiles::default(), "shell", None, &found).unwrap_err();
        assert_eq!(err.code(), "unknown_profile");
    }

    #[test]
    fn resolve_missing_gemini_is_not_installed() {
        let err = run(&Profiles::default(), "gemini", None, &|_| None).unwrap_err();
        assert_eq!(err.code(), "not_installed");
        assert_eq!(err.to_string(), "gemini");
    }

    #[test]
    fn resolve_missing_claude_is_no_claude() {
        let p = Profiles::default();
        assert_eq!(
            run(&p, "claude", None, &|_| None).unwrap_err().code(),
            "no_claude"
        );
        assert_eq!(
            run(&p, "codex", None, &|_| None).unwrap_err().code(),
            "no_codex"
        );
    }

    #[test]
    fn resolve_missing_custom_names_its_program() {
        let err = run(&with(custom("mine")), "mine", None, &|_| None).unwrap_err();
        assert_eq!(err.code(), "not_installed");
        assert_eq!(err.to_string(), "aider");
    }

    #[test]
    fn find_gets_the_profile() {
        let mut c = custom("mine");
        c.program = Some("/opt/mine".into());
        let l = run(&with(c), "mine", None, &|p| {
            p.program.as_deref().map(PathBuf::from)
        })
        .unwrap();
        assert_eq!(l.program, PathBuf::from("/opt/mine"));
    }

    #[test]
    fn account_sets_home_var() {
        let mut c = builtin(Cli::Claude);
        c.account = Some("work".into());
        let l = run(&with(c), "claude", None, &found).unwrap();
        assert_eq!(l.env, [("CLAUDE_CONFIG_DIR".to_owned(), "D".into())]);
        assert_eq!(l.account.as_deref(), Some("work"));

        let mut x = builtin(Cli::Codex);
        x.account = Some("gpt".into());
        let l = run(&with(x), "codex", None, &found).unwrap();
        assert_eq!(l.env, [("CODEX_HOME".to_owned(), "E".into())]);
    }

    #[test]
    fn account_override_wins_and_must_match_provider() {
        let mut c = builtin(Cli::Claude);
        c.account = Some("nobody".into());
        let p = with(c);
        // The override replaces the profile's own account, even a broken one.
        let l = run(&p, "claude", Some("work"), &found).unwrap();
        assert_eq!(l.account.as_deref(), Some("work"));
        // Another provider's account, or a missing one, is refused.
        for name in ["gpt", "nobody", ""] {
            let err = run(&p, "claude", Some(name), &found).unwrap_err();
            assert_eq!(err.code(), "unknown_account", "{name}");
        }
        let err = run(&Profiles::default(), "codex", Some("work"), &found).unwrap_err();
        assert_eq!(err.code(), "unknown_account");
    }

    #[test]
    fn only_claude_and_codex_take_an_account() {
        let p = Profiles::default();
        let err = run(&p, "gemini", Some("work"), &found).unwrap_err();
        assert_eq!(err.code(), "unknown_account");
        let err = run(&with(custom("mine")), "mine", Some("work"), &found).unwrap_err();
        assert_eq!(err.code(), "unknown_account");
        let mut c = custom("mine");
        c.account = Some("work".into());
        let err = run(&with(c), "mine", None, &found).unwrap_err();
        assert_eq!(err.code(), "unknown_account");
    }

    /// `accounts()` with `work` (Claude) and `gpt` (Codex) active, plus a
    /// second Claude account `home`.
    fn run_active(
        profiles: &Profiles,
        id: &str,
        account: Option<&str>,
    ) -> Result<Launch, LaunchError> {
        let mut accounts = accounts();
        accounts
            .add("home", Provider::Claude, PathBuf::from("H"))
            .unwrap();
        accounts.activate(Provider::Claude, Some("work")).unwrap();
        accounts.activate(Provider::Codex, Some("gpt")).unwrap();
        resolve(
            id,
            &Context {
                profiles,
                accounts: &accounts,
                shells: &[],
                find: &found,
                account,
                prompt: None,
            },
        )
    }

    #[test]
    fn builtin_without_account_runs_as_the_active_one() {
        let p = Profiles::default();
        let l = run_active(&p, "claude", None).unwrap();
        assert_eq!(l.account.as_deref(), Some("work"));
        assert_eq!(l.account_source, Some(AccountSource::Active));
        assert_eq!(l.env, [("CLAUDE_CONFIG_DIR".to_owned(), "D".into())]);
        let l = run_active(&p, "codex", None).unwrap();
        assert_eq!(l.account.as_deref(), Some("gpt"));
        assert_eq!(l.account_source, Some(AccountSource::Active));
        assert_eq!(l.env, [("CODEX_HOME".to_owned(), "E".into())]);
    }

    #[test]
    fn tab_account_wins_over_profile_and_active() {
        let mut c = builtin(Cli::Claude);
        c.account = Some("work".into());
        let l = run_active(&with(c), "claude", Some("home")).unwrap();
        assert_eq!(l.account.as_deref(), Some("home"));
        assert_eq!(l.account_source, Some(AccountSource::Tab));
        assert_eq!(l.env, [("CLAUDE_CONFIG_DIR".to_owned(), "H".into())]);
    }

    #[test]
    fn profile_account_wins_over_active() {
        let mut c = builtin(Cli::Claude);
        c.account = Some("home".into());
        let l = run_active(&with(c), "claude", None).unwrap();
        assert_eq!(l.account.as_deref(), Some("home"));
        assert_eq!(l.account_source, Some(AccountSource::Profile));
        // Without an active account the source is the same.
        let mut c = builtin(Cli::Claude);
        c.account = Some("work".into());
        let l = run(&with(c), "claude", None, &found).unwrap();
        assert_eq!(l.account_source, Some(AccountSource::Profile));
        let l = run(&Profiles::default(), "claude", Some("work"), &found).unwrap();
        assert_eq!(l.account_source, Some(AccountSource::Tab));
    }

    #[test]
    fn no_provider_ignores_the_active_account() {
        // A custom program and Gemini have no account home; they start as
        // before rather than failing on an account they cannot take.
        for (profiles, id) in [
            (with(custom("mine")), "mine"),
            (Profiles::default(), "gemini"),
        ] {
            let l = run_active(&profiles, id, None).unwrap();
            assert_eq!((l.account, l.account_source), (None, None), "{id}");
            assert!(l.env.is_empty(), "{id}");
        }
    }

    #[test]
    fn no_active_account_is_the_cli_home() {
        let l = run(&Profiles::default(), "claude", None, &found).unwrap();
        assert_eq!((l.account, l.account_source), (None, None));
        assert!(l.env.is_empty());
    }

    #[test]
    fn account_home_wins_over_profile_env() {
        let mut c = builtin(Cli::Claude);
        c.account = Some("work".into());
        c.env = vec![
            EnvVar {
                name: "CLAUDE_CONFIG_DIR".into(),
                value: "other".into(),
            },
            EnvVar {
                name: "A".into(),
                value: "1".into(),
            },
        ];
        let l = run(&with(c), "claude", None, &found).unwrap();
        assert_eq!(
            l.env,
            [
                ("A".to_owned(), "1".into()),
                ("CLAUDE_CONFIG_DIR".to_owned(), "D".into())
            ]
        );
    }

    #[test]
    fn env_names_match_case_only_on_windows() {
        let mut c = builtin(Cli::Claude);
        c.account = Some("work".into());
        c.env = vec![EnvVar {
            name: "claude_config_dir".into(),
            value: "other".into(),
        }];
        let l = run(&with(c), "claude", None, &found).unwrap();
        let home = ("CLAUDE_CONFIG_DIR".to_owned(), "D".into());
        if cfg!(windows) {
            assert_eq!(l.env, [home]);
        } else {
            assert_eq!(
                l.env,
                [("claude_config_dir".to_owned(), "other".into()), home]
            );
        }
    }

    #[test]
    fn custom_profile_env_and_args() {
        let mut c = custom("mine");
        c.args = vec!["--yes".into()];
        c.env = vec![EnvVar {
            name: "A".into(),
            value: "x=y".into(),
        }];
        c.model = Some("ignored".into());
        c.startup = vec!["  cd src ".into(), "   ".into(), "nvm use".into()];
        let mut p = with(c);
        p.approvals = Approvals::Skip;
        let l = run(&p, "mine", None, &found).unwrap();
        // A custom profile has no flag mapping and always asks.
        assert_eq!(l.args, ["--yes"]);
        assert_eq!(l.env, [("A".to_owned(), "x=y".into())]);
        assert_eq!(l.permissions, Permissions::Ask);
        assert!(l.agent && l.account.is_none());
        assert_eq!(l.startup, ["cd src", "nvm use"]);
    }

    // --- command ---

    fn launch_of(program: &str, args: &[&str], startup: &[&str]) -> Launch {
        Launch {
            profile: "x".into(),
            program: PathBuf::from(program),
            args: args.iter().map(|a| (*a).to_owned()).collect(),
            env: Vec::new(),
            agent: true,
            permissions: Permissions::Ask,
            account: None,
            account_source: None,
            startup: startup.iter().map(|a| (*a).to_owned()).collect(),
            cli: None,
            hooks: false,
            hook_events: Vec::new(),
            prompt_after: None,
            prompt_argv: Vec::new(),
        }
    }

    // --- hooks ---

    #[test]
    fn resolve_records_the_cli() {
        let p = Profiles::default();
        let l = run(&p, "claude", None, &found).unwrap();
        assert_eq!((l.cli, l.hooks), (Some(Cli::Claude), false));
        let l = run(&p, "codex", None, &found).unwrap();
        assert_eq!(l.cli, Some(Cli::Codex));
        let l = run(&with(custom("mine")), "mine", None, &found).unwrap();
        assert_eq!(l.cli, None);
    }

    #[test]
    fn add_hooks_appends_after_the_profile_args_once() {
        let mut c = builtin(Cli::Claude);
        c.args = vec!["--verbose".into()];
        c.startup = vec!["nvm use".into()];
        let mut l = run(&with(c), "claude", None, &found).unwrap();
        let xdev = Path::new("/opt/xdev");
        let version = Some(CliVersion(2, 1, 317));
        l.add_hooks_with(xdev, None, version);
        let hooks = hook_args(Cli::Claude, xdev, version);
        assert_eq!(l.args[..1], ["--verbose"]);
        assert_eq!(l.args[1..], hooks[..]);
        assert!(l.hooks);
        l.add_hooks_with(xdev, None, version);
        l.add_hooks(xdev, Path::new("/no/data"));
        assert_eq!(l.args.len(), 3);
        // The startup wrapper carries them as the CLI's own args.
        let (_, wrapped) = l.command();
        assert!(!wrapped.is_empty());
    }

    #[test]
    fn add_hooks_offers_an_unknown_claude_only_two_events() {
        let p = Profiles::default();
        let xdev = Path::new("/opt/xdev");
        let mut unknown = run(&p, "claude", None, &found).unwrap();
        // `found` points at a program that does not exist: no version.
        unknown.add_hooks(xdev, Path::new("/no/data"));
        assert_eq!(
            unknown.args[unknown.args.len() - 2..],
            hook_args(Cli::Claude, xdev, None)[..]
        );
        let mut known = run(&p, "claude", None, &found).unwrap();
        known.add_hooks_with(xdev, None, Some(CliVersion(2, 1, 317)));
        assert_ne!(known.args, unknown.args);
        let settings = known.args.last().unwrap();
        assert!(settings.contains("PermissionRequest"));
        assert!(!unknown.args.last().unwrap().contains("PermissionRequest"));
    }

    #[test]
    fn add_hooks_leaves_others_alone() {
        let xdev = Path::new("/opt/xdev");
        let p = Profiles::default();
        let mut gemini = run(&p, "gemini", None, &found).unwrap();
        let before = gemini.args.clone();
        gemini.add_hooks(xdev, Path::new("/no/data"));
        assert_eq!((gemini.args, gemini.hooks), (before, false));

        let mut aider = run(&with(custom("mine")), "mine", None, &found).unwrap();
        aider.add_hooks(xdev, Path::new("/no/data"));
        assert!(!aider.hooks && aider.args.is_empty());

        let mut shell = launch_of("/bin/sh", &[], &[]);
        shell.agent = false;
        shell.cli = Some(Cli::Claude);
        shell.add_hooks(xdev, Path::new("/no/data"));
        assert!(!shell.hooks && shell.args.is_empty());
    }

    /// A codex launch whose own home is a fake one in `root`.
    fn codex_in(root: &Path, var: &str) -> (Launch, PathBuf) {
        let real = root.join("real-codex");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("auth.json"), "{}").unwrap();
        let mut l = run(&Profiles::default(), "codex", None, &found).unwrap();
        l.env.push((var.to_owned(), real.clone().into_os_string()));
        (l, real)
    }

    fn home_of(l: &Launch) -> Vec<&OsString> {
        l.env
            .iter()
            .filter(|(k, _)| k.eq_ignore_ascii_case("CODEX_HOME"))
            .map(|(_, v)| v)
            .collect()
    }

    #[test]
    fn codex_gets_its_private_home_and_keeps_notify() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        let xdev = Path::new("/opt/xdev");
        let (mut l, real) = codex_in(tmp.path(), "CODEX_HOME");
        l.add_hooks_with(xdev, Some(&data), Some(CliVersion(0, 165, 0)));
        assert!(l.hooks);
        assert_eq!(
            l.args[l.args.len() - 2..],
            hook_args(Cli::Codex, xdev, None)[..]
        );
        let homes = home_of(&l);
        assert_eq!(homes.len(), 1);
        let home = PathBuf::from(homes[0]);
        assert_ne!(home, real);
        assert!(home.join("hooks.json").is_file());
        assert!(home.parent().unwrap().ends_with("codex-home"));
        assert!(
            home.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("default-")
        );
    }

    #[test]
    #[cfg(windows)]
    fn codex_home_var_case_is_ignored_on_windows() {
        // Elsewhere `codex_home` would not match and the real default home
        // would be used: not run there.
        let tmp = tempfile::tempdir().unwrap();
        let (mut l, _) = codex_in(tmp.path(), "codex_home");
        l.add_hooks_with(
            Path::new("/opt/xdev"),
            Some(&tmp.path().join("data")),
            Some(CliVersion(0, 165, 0)),
        );
        // The profile's variable named the home, and was replaced.
        let homes = home_of(&l);
        assert_eq!(homes.len(), 1);
        assert!(PathBuf::from(homes[0]).join("hooks.json").is_file());
    }

    #[test]
    fn old_unknown_or_failing_codex_stays_on_notify() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        let xdev = Path::new("/opt/xdev");
        for version in [None, Some(CliVersion(0, 135, 0))] {
            let (mut l, real) = codex_in(tmp.path(), "CODEX_HOME");
            l.add_hooks_with(xdev, Some(&data), version);
            assert!(l.hooks);
            assert_eq!(home_of(&l), [real.as_os_str()]);
        }
        // No auth.json in the real home: setup fails, the launch is as before.
        let (mut l, real) = codex_in(tmp.path(), "CODEX_HOME");
        std::fs::rename(real.join("auth.json"), real.join("moved")).unwrap();
        l.add_hooks_with(xdev, Some(&data), Some(CliVersion(0, 165, 0)));
        assert!(l.hooks);
        assert_eq!(home_of(&l), [real.as_os_str()]);
        assert!(
            !data
                .join("codex-home")
                .join("default")
                .join("auth.json")
                .exists()
        );
    }

    #[test]
    fn hook_events_say_what_the_launch_reports() {
        use crate::hooks::HookEvent::*;
        let p = Profiles::default();
        let xdev = Path::new("/opt/xdev");
        let mut unknown = run(&p, "claude", None, &found).unwrap();
        assert!(unknown.hook_events.is_empty());
        unknown.add_hooks_with(xdev, None, None);
        assert_eq!(unknown.hook_events, [Prompt, TurnDone]);
        let mut known = run(&p, "claude", None, &found).unwrap();
        known.add_hooks_with(xdev, None, Some(CliVersion(2, 1, 317)));
        assert_eq!(
            known.hook_events,
            [Prompt, NeedsInput, Resume, TurnFailed, TurnDone]
        );

        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        // Private home: the hooks it holds; Interrupt only from 0.150.
        let (mut l, _) = codex_in(tmp.path(), "CODEX_HOME");
        l.add_hooks_with(xdev, Some(&data), Some(CliVersion(0, 165, 0)));
        assert_eq!(
            l.hook_events,
            [Prompt, NeedsInput, Resume, TurnDone, Interrupt]
        );
        let (mut l, _) = codex_in(tmp.path(), "CODEX_HOME");
        l.add_hooks_with(xdev, Some(&data), Some(CliVersion(0, 140, 0)));
        assert_eq!(l.hook_events, [Prompt, NeedsInput, Resume, TurnDone]);
        // notify alone: the end of a turn only.
        let (mut l, _) = codex_in(tmp.path(), "CODEX_HOME");
        l.add_hooks_with(xdev, Some(&data), Some(CliVersion(0, 135, 0)));
        assert_eq!(l.hook_events, [TurnDone]);
    }

    #[test]
    fn command_without_startup_is_as_given() {
        let l = launch_of("/bin/a", &["-x", "y z"], &[]);
        assert_eq!(l.command(), (PathBuf::from("/bin/a"), l.args.clone()));
    }

    #[test]
    fn command_with_startup_runs_the_wrapper() {
        let l = launch_of("/bin/a", &["-x"], &["cd src"]);
        let (program, args) = l.command();
        if cfg!(windows) {
            assert_eq!(program, PathBuf::from("powershell.exe"));
            assert_eq!(args[..3], ["-NoLogo", "-NoProfile", "-EncodedCommand"]);
        } else {
            assert_eq!(args[..2], ["-l", "-c"]);
            assert!(args[2].starts_with("cd src\nexec '/bin/a' '-x'"));
        }
    }

    /// Standard-alphabet base64 decoding, only for these tests.
    fn unbase64(text: &str) -> Vec<u8> {
        const ALPHABET: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut bits = 0u32;
        let mut count = 0;
        let mut out = Vec::new();
        for c in text.trim_end_matches('=').chars() {
            bits = bits << 6 | ALPHABET.find(c).unwrap() as u32;
            count += 6;
            if count >= 8 {
                count -= 8;
                out.push((bits >> count) as u8);
                bits &= (1 << count) - 1;
            }
        }
        out
    }

    fn decode_powershell(args: &[String]) -> String {
        assert_eq!(args[..3], ["-NoLogo", "-NoProfile", "-EncodedCommand"]);
        let units: Vec<u16> = unbase64(&args[3])
            .chunks(2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .collect();
        String::from_utf16(&units).unwrap()
    }

    #[test]
    fn startup_quotes_program_and_args() {
        let lines = ["cd x".to_owned()];
        let args = ["it's;rm".to_owned()];

        let (program, wrapped) = wrap_powershell(&lines, r"C:\Program Files\a'b.exe", &args);
        assert_eq!(program, PathBuf::from("powershell.exe"));
        assert_eq!(
            decode_powershell(&wrapped),
            r"cd x; & 'C:\Program Files\a''b.exe' 'it''s;rm'; exit $(if ($null -eq $LASTEXITCODE) { 1 } else { $LASTEXITCODE })"
        );

        let (shell, wrapped) = wrap_posix(Path::new("/bin/zsh"), &lines, "/opt/a b", &args);
        assert_eq!(shell, PathBuf::from("/bin/zsh"));
        assert_eq!(wrapped[..2], ["-l", "-c"]);
        assert_eq!(wrapped[2], "cd x\nexec '/opt/a b' 'it'\\''s;rm'");
    }

    #[test]
    fn startup_joins_lines_and_quotes_typographic_quotes() {
        let lines = ["cd x".to_owned(), "nvm use".to_owned()];
        let args = ["a\u{2019};b".to_owned(), "".to_owned()];

        let (_, wrapped) = wrap_powershell(&lines, "p", &args);
        assert_eq!(
            decode_powershell(&wrapped),
            "cd x; nvm use; & 'p' 'a\u{2019}\u{2019};b' '\"\"'; exit $(if ($null -eq $LASTEXITCODE) { 1 } else { $LASTEXITCODE })"
        );
        let (_, wrapped) = wrap_posix(Path::new("/bin/sh"), &lines, "p", &args);
        assert_eq!(wrapped[2], "cd x\nnvm use\nexec 'p' 'a\u{2019};b' ''");
    }

    #[test]
    fn powershell_args_survive_native_passing() {
        let tail = "; exit $(if ($null -eq $LASTEXITCODE) { 1 } else { $LASTEXITCODE })";
        let script = |args: &[&str]| {
            let args: Vec<String> = args.iter().map(|a| (*a).to_owned()).collect();
            let (_, wrapped) = wrap_powershell(&["cd x".to_owned()], "p", &args);
            decode_powershell(&wrapped)
        };
        // An embedded quote is escaped; an empty arg becomes `""`.
        assert_eq!(
            script(&[r#"say "hi""#, ""]),
            format!(r#"cd x; & 'p' 'say \"hi\"' '""'{tail}"#)
        );
        // A quote without whitespace is escaped the same way.
        assert_eq!(script(&[r#"a"b"#]), format!(r#"cd x; & 'p' 'a\"b'{tail}"#));
        // Backslashes before a quote double; a trailing run doubles only
        // when the arg gets wrapped in quotes (it has whitespace).
        assert_eq!(
            script(&[r#"a\"b"#, r"C:\dir\", r"C:\my dir\"]),
            format!(r#"cd x; & 'p' 'a\\\"b' 'C:\dir\' 'C:\my dir\\'{tail}"#)
        );
        // Whitespace, quote and backslash together.
        assert_eq!(
            script(&[r#"x\\"y z\"#]),
            format!(r#"cd x; & 'p' 'x\\\\\"y z\\'{tail}"#)
        );
    }

    #[test]
    fn base64_vectors() {
        for (input, expected) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64(input.as_bytes()), expected, "{input:?}");
        }
    }

    fn strs(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).to_owned()).collect()
    }

    fn over(model: &str, effort: &str, extra: &[&str]) -> LaunchOverrides {
        LaunchOverrides {
            model: (!model.is_empty()).then(|| model.to_owned()),
            effort: (!effort.is_empty()).then(|| effort.to_owned()),
            extra_args: strs(extra),
        }
    }

    #[test]
    fn override_model_replaces_the_profile_model_for_claude() {
        let mut args = strs(&["--model", "sonnet", "--effort", "low", "--verbose"]);
        apply_overrides(
            Some(Cli::Claude),
            &mut args,
            &over("opus", "high", &["--x"]),
        );
        assert_eq!(
            args,
            ["--model", "opus", "--effort", "high", "--verbose", "--x"]
        );
        assert_eq!(args.iter().filter(|a| *a == "--model").count(), 1);
    }

    #[test]
    fn override_removes_the_inline_form_too() {
        let mut args = strs(&["--model=sonnet", "--effort=low"]);
        apply_overrides(Some(Cli::Claude), &mut args, &over("opus", "max", &[]));
        assert_eq!(args, ["--model", "opus", "--effort", "max"]);
    }

    #[test]
    fn empty_overrides_leave_the_profile() {
        for cli in [Cli::Claude, Cli::Codex, Cli::Gemini, Cli::Cursor] {
            let mut args = strs(&["-m", "keep", "--flag"]);
            let before = args.clone();
            apply_overrides(Some(cli), &mut args, &over("", " ", &[]));
            assert_eq!(args, before, "{cli:?}");
        }
    }

    #[test]
    fn override_wins_for_codex_and_others() {
        let mut args = strs(&["-m", "old", "-c", "model_reasoning_effort=low", "--k"]);
        apply_overrides(
            Some(Cli::Codex),
            &mut args,
            &over("gpt-x", "high", &["--e"]),
        );
        assert_eq!(
            args,
            [
                "-m",
                "gpt-x",
                "-c",
                "model_reasoning_effort=high",
                "--k",
                "--e"
            ]
        );
        let mut gem = strs(&["-m", "old"]);
        apply_overrides(
            Some(Cli::Gemini),
            &mut gem,
            &over("gemini-2.5-pro", "high", &[]),
        );
        // Gemini has no effort flag; the effort is ignored.
        assert_eq!(gem, ["-m", "gemini-2.5-pro"]);
    }

    #[test]
    fn extra_args_go_last_and_a_resume_subcommand_stays_first() {
        let mut args = strs(&["resume", "abc", "-m", "old", "--hook"]);
        apply_overrides(Some(Cli::Codex), &mut args, &over("new", "", &["--z", "1"]));
        assert_eq!(args, ["resume", "abc", "-m", "new", "--hook", "--z", "1"]);
    }

    #[test]
    fn a_custom_program_only_gets_the_extra_args() {
        let mut args = strs(&["--model", "keep"]);
        apply_overrides(None, &mut args, &over("m", "e", &["--a"]));
        assert_eq!(args, ["--model", "keep", "--a"]);
    }

    #[test]
    fn overrides_load_from_old_json_and_clamp() {
        let o: LaunchOverrides = serde_json::from_str("{}").unwrap();
        assert_eq!(o, LaunchOverrides::default());
        assert!(o.is_empty());
        let o: LaunchOverrides =
            serde_json::from_str(r#"{"model":"  ","extraArgs":["a\nb"," ok "]}"#).unwrap();
        let c = o.clamped();
        assert_eq!(c.model, None);
        assert_eq!(c.extra_args, ["ok"]);
        let long = LaunchOverrides {
            model: Some("m".repeat(500)),
            effort: None,
            extra_args: (0..100).map(|i| i.to_string()).collect(),
        };
        let c = long.clamped();
        assert_eq!(c.model.unwrap().chars().count(), OVERRIDE_TEXT_MAX);
        assert_eq!(c.extra_args.len(), OVERRIDE_ARGS_MAX);
    }
}
