//! What a terminal runs: the user's shell or an agent CLI, by profile id.

use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use xdev_ai::{AiError, Provider, Registry, claude_command, codex_command};

use crate::flags::flags;
use crate::profiles::{Cli, Permissions, Profile, ProfileError, Profiles};

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
    /// Shell lines to run before the CLI; see `command`.
    pub startup: Vec<String>,
}

impl Launch {
    /// What to spawn: `program` and `args` as they are, or, with startup
    /// lines, a shell that runs the lines and then the CLI. The wrapper
    /// quotes the CLI's program and args, so each stays one argument.
    pub fn command(&self) -> (PathBuf, Vec<String>) {
        if self.startup.is_empty() {
            return (self.program.clone(), self.args.clone());
        }
        let program = self.program.to_string_lossy();
        if cfg!(windows) {
            wrap_powershell(&self.startup, &program, &self.args)
        } else {
            let shell = env::var_os("SHELL")
                .filter(|s| !s.is_empty())
                .map_or_else(|| PathBuf::from("/bin/sh"), PathBuf::from);
            wrap_posix(&shell, &self.startup, &program, &self.args)
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
    /// The program of a profile, or `None` when it is not installed.
    pub find: &'a dyn Fn(&Profile) -> Option<PathBuf>,
    /// An account that replaces the profile's own (a restart keeps the
    /// tab's account).
    pub account: Option<&'a str>,
}

/// The launch of the agent profile `id`.
pub fn resolve(id: &str, ctx: &Context) -> Result<Launch, LaunchError> {
    let profile = ctx.profiles.get(id).ok_or(LaunchError::UnknownProfile)?;
    if !profile.enabled {
        return Err(LaunchError::Off);
    }
    let program = (ctx.find)(profile).ok_or_else(|| match profile.cli {
        Some(Cli::Claude) => LaunchError::NotInstalled(AiError::NoClaude.code()),
        Some(Cli::Codex) => LaunchError::NotInstalled(AiError::NoCodex.code()),
        Some(Cli::Gemini) => LaunchError::NotFound(Cli::Gemini.as_str().to_owned()),
        None => LaunchError::NotFound(profile.program.clone().unwrap_or_default()),
    })?;

    let permissions = ctx.profiles.effective(profile);
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

    let mut env: Vec<(String, OsString)> = profile
        .env
        .iter()
        .map(|e| (e.name.clone(), OsString::from(&e.value)))
        .collect();
    let account = ctx.account.or(profile.account.as_deref());
    if let Some(name) = account {
        let provider = match profile.cli {
            Some(Cli::Claude) => Provider::Claude,
            Some(Cli::Codex) => Provider::Codex,
            _ => return Err(LaunchError::UnknownAccount),
        };
        let entry = ctx
            .accounts
            .get(name)
            .filter(|a| a.provider == provider)
            .ok_or(LaunchError::UnknownAccount)?;
        // The account's folder wins over a variable of the same name.
        let var = provider.home_var();
        env.retain(|(name, _)| !name.eq_ignore_ascii_case(var));
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
        startup: profile
            .startup
            .iter()
            .map(|line| line.trim().to_owned())
            .filter(|line| !line.is_empty())
            .collect(),
    })
}

pub fn launch(profile_id: &str) -> Result<Launch, LaunchError> {
    launch_with(profile_id, |id| {
        let command = if id == "claude" {
            claude_command()?
        } else {
            codex_command()?
        };
        Ok(PathBuf::from(command.get_program()))
    })
}

/// `find` locates an agent CLI by id; tests pass their own.
pub fn launch_with(
    profile_id: &str,
    find: impl Fn(&str) -> Result<PathBuf, AiError>,
) -> Result<Launch, LaunchError> {
    let (program, args, agent) = match profile_id {
        "shell" => {
            let (program, args) = shell();
            (program, args, false)
        }
        "claude" | "codex" => {
            let program = find(profile_id).map_err(|e| LaunchError::NotInstalled(e.code()))?;
            (program, Vec::new(), true)
        }
        _ => return Err(LaunchError::UnknownProfile),
    };
    Ok(Launch {
        profile: profile_id.to_owned(),
        program,
        args,
        env: Vec::new(),
        agent,
        permissions: Permissions::Ask,
        account: None,
        startup: Vec::new(),
    })
}

/// `pwsh.exe` when installed, else Windows PowerShell; `$SHELL` elsewhere.
fn shell() -> (PathBuf, Vec<String>) {
    if cfg!(windows) {
        let program = on_path("pwsh.exe").unwrap_or_else(|| PathBuf::from("powershell.exe"));
        (program, vec!["-NoLogo".to_owned()])
    } else {
        let program = env::var_os("SHELL")
            .filter(|s| !s.is_empty())
            .map_or_else(|| PathBuf::from("/bin/sh"), PathBuf::from);
        (program, Vec::new())
    }
}

fn on_path(name: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|p| p.is_file())
}

/// Windows PowerShell running `lines`, then the program with its args, and
/// exiting with the program's code. The script travels as base64 of UTF-16LE
/// so no layer of command-line quoting touches it.
fn wrap_powershell(lines: &[String], program: &str, args: &[String]) -> (PathBuf, Vec<String>) {
    let mut script = lines.join("; ");
    script.push_str("; & ");
    script.push_str(&ps_quote(program));
    for arg in args {
        script.push(' ');
        script.push_str(&ps_quote(arg));
    }
    script.push_str("; exit $LASTEXITCODE");
    let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let args = ["-NoLogo", "-NoProfile", "-EncodedCommand"]
        .map(str::to_owned)
        .into_iter()
        .chain([base64(&utf16)])
        .collect();
    (PathBuf::from("powershell.exe"), args)
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

    #[test]
    fn unknown_profile_is_an_error() {
        assert_eq!(launch("vim").unwrap_err().code(), "unknown_profile");
    }

    #[test]
    fn shell_is_not_an_agent() {
        let l = launch("shell").unwrap();
        assert!(!l.agent && l.program.file_stem().is_some());
    }

    #[test]
    fn claude_uses_the_found_program() {
        let bin = PathBuf::from(r"C:\npm\claude.cmd");
        let l = launch_with("claude", |id| {
            assert_eq!(id, "claude");
            Ok(bin.clone())
        })
        .unwrap();
        assert_eq!(l.program, bin);
        assert!(l.agent && l.args.is_empty());
    }

    #[test]
    fn missing_codex_maps_to_no_codex() {
        let err = launch_with("codex", |_| Err(AiError::NoCodex)).unwrap_err();
        assert_eq!(err.code(), "no_codex");
    }

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
                find,
                account,
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
        let err = run(&with(custom("aider")), "aider", None, &|_| None).unwrap_err();
        assert_eq!(err.code(), "not_installed");
        assert_eq!(err.to_string(), "aider");
    }

    #[test]
    fn find_gets_the_profile() {
        let mut c = custom("aider");
        c.program = Some("/opt/aider".into());
        let l = run(&with(c), "aider", None, &|p| {
            p.program.as_deref().map(PathBuf::from)
        })
        .unwrap();
        assert_eq!(l.program, PathBuf::from("/opt/aider"));
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
        let err = run(&with(custom("aider")), "aider", Some("work"), &found).unwrap_err();
        assert_eq!(err.code(), "unknown_account");
        let mut c = custom("aider");
        c.account = Some("work".into());
        let err = run(&with(c), "aider", None, &found).unwrap_err();
        assert_eq!(err.code(), "unknown_account");
    }

    #[test]
    fn account_home_wins_over_profile_env() {
        let mut c = builtin(Cli::Claude);
        c.account = Some("work".into());
        c.env = vec![
            EnvVar {
                name: "claude_config_dir".into(),
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
    fn custom_profile_env_and_args() {
        let mut c = custom("aider");
        c.args = vec!["--yes".into()];
        c.env = vec![EnvVar {
            name: "A".into(),
            value: "x=y".into(),
        }];
        c.model = Some("ignored".into());
        c.startup = vec!["  cd src ".into(), "   ".into(), "nvm use".into()];
        let mut p = with(c);
        p.approvals = Approvals::Skip;
        let l = run(&p, "aider", None, &found).unwrap();
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
            startup: startup.iter().map(|a| (*a).to_owned()).collect(),
        }
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
            r"cd x; & 'C:\Program Files\a''b.exe' 'it''s;rm'; exit $LASTEXITCODE"
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
            "cd x; nvm use; & 'p' 'a\u{2019}\u{2019};b' ''; exit $LASTEXITCODE"
        );
        let (_, wrapped) = wrap_posix(Path::new("/bin/sh"), &lines, "p", &args);
        assert_eq!(wrapped[2], "cd x\nnvm use\nexec 'p' 'a\u{2019};b' ''");
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
}
