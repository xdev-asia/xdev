//! An agent profile that runs inside a WSL distro: the folder it starts in,
//! the `wsl.exe` command line and the env it forwards. Everything here is
//! pure; the caller checks the distro list and spawns `wsl.exe`.

use std::ffi::OsStr;
use std::path::PathBuf;

use crate::catalog::spec;
use crate::launch::{base64, sh_quote};
use crate::profiles::Profile;

/// A first prompt longer than this (in bytes) is typed once the agent has
/// started instead of being passed as an argument: Windows caps a command
/// line at 32 767 UTF-16 units and base64 grows the script by a third.
pub const PROMPT_ARGV_MAX: usize = 8_000;

/// The longest distro name a profile takes.
const DISTRO_MAX: usize = 64;

/// The fixed `sh -c` script `wsl.exe` runs: it reads the user's login shell
/// (`/bin/sh` when that is not executable), decodes the launch script from
/// `$1` and runs it in a login, interactive shell, so the profile and rc
/// files that put version-managed CLIs on `PATH` are read. One line.
pub const BOOT: &str = "s=$(getent passwd \"$(id -un)\" | cut -d: -f7); \
[ -x \"$s\" ] || s=/bin/sh; \
script=$(printf %s \"$1\" | base64 -d) || exit 1; \
exec \"$s\" -l -i -c \"$script\"";

/// The folder `wsl.exe --cd` gets for a worktree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WslCwd {
    /// A drive path, passed as it is: the distro maps it through its own
    /// automount root.
    Windows(String),
    /// A path inside `distro` (from `\\wsl$\<distro>\…` or
    /// `\\wsl.localhost\<distro>\…`).
    Linux { distro: String, path: String },
}

impl WslCwd {
    /// The value for `--cd`.
    pub fn cd(&self) -> &str {
        match self {
            WslCwd::Windows(path) => path,
            WslCwd::Linux { path, .. } => path,
        }
    }
}

/// The folder cannot be opened in WSL: another UNC share, a relative path or
/// a bare drive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("this folder cannot be opened in WSL")]
pub struct WslPathError;

/// Where a worktree folder is from inside WSL; see `WslCwd`.
pub fn cwd_for(path: &str) -> Result<WslCwd, WslPathError> {
    let path = path.replace('/', "\\");
    let path = if let Some(rest) = strip_prefix_ci(&path, r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_owned()
    } else {
        path
    };
    if let Some(unc) = path.strip_prefix(r"\\") {
        let mut parts = unc.split('\\');
        let host = parts.next().unwrap_or_default();
        if !(host.eq_ignore_ascii_case("wsl$") || host.eq_ignore_ascii_case("wsl.localhost")) {
            return Err(WslPathError);
        }
        let distro = parts.next().unwrap_or_default();
        if distro.is_empty() {
            return Err(WslPathError);
        }
        let rest: Vec<&str> = parts.filter(|p| !p.is_empty()).collect();
        return Ok(WslCwd::Linux {
            distro: distro.to_owned(),
            path: format!("/{}", rest.join("/")),
        });
    }
    let bytes = path.as_bytes();
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\' {
        return Ok(WslCwd::Windows(path));
    }
    Err(WslPathError)
}

fn strip_prefix_ci<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let head = text.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| &text[prefix.len()..])
}

/// A distro name a profile may store: `[A-Za-z0-9._-]{1,64}`, not starting
/// with `-` (it lands in `wsl.exe -d` argv).
pub fn valid_distro(name: &str) -> bool {
    (1..=DISTRO_MAX).contains(&name.len())
        && !name.starts_with('-')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// The program a WSL profile runs inside the distro: a custom profile's
/// program as written (trimmed), a built-in's first command name. Nothing
/// is probed inside the distro.
pub fn program(profile: &Profile) -> Option<PathBuf> {
    match profile.cli {
        Some(cli) => spec(cli).commands.first().map(PathBuf::from),
        None => profile
            .program
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(PathBuf::from),
    }
}

/// The launch script: each startup line on its own line, then `exec` of the
/// program with its arguments, each single-quoted.
pub fn script<S: AsRef<str>, A: AsRef<str>>(startup: &[S], program: &str, args: &[A]) -> String {
    let mut out = String::new();
    for line in startup {
        out.push_str(line.as_ref());
        out.push('\n');
    }
    out.push_str("exec ");
    out.push_str(&sh_quote(program));
    for arg in args {
        out.push(' ');
        out.push_str(&sh_quote(arg.as_ref()));
    }
    out
}

/// The `wsl.exe` arguments that run `script(startup, program, args)` in
/// `distro`, starting in `cd`. The script travels as base64, so no layer of
/// command-line quoting touches the agent's arguments; only `BOOT` does.
pub fn argv<S: AsRef<str>, A: AsRef<str>>(
    distro: &str,
    cd: &str,
    program: &str,
    args: &[A],
    startup: &[S],
) -> Vec<String> {
    let encoded = base64(script(startup, program, args).as_bytes());
    [
        "-d", distro, "--cd", cd, "--exec", "sh", "-c", BOOT, "xdev", &encoded,
    ]
    .map(str::to_owned)
    .into()
}

/// The program as the policy gate and the approvals see it: an approval for
/// a Windows CLI does not carry into a distro, nor across distros.
pub fn label(distro: &str, program: &str) -> String {
    format!("wsl:{distro}:{program}")
}

/// `WSLENV` for a launch with `env`: every name once with `/u` (Windows to
/// WSL only), `/up` when the value is an absolute Windows path. `PATH`,
/// `XDEV_CLI`, `WSLENV` and names a shell cannot hold are never listed. An
/// `existing` value stays in front. `None` when there is nothing to set.
pub fn wslenv<K: AsRef<str>, V: AsRef<OsStr>>(
    env: &[(K, V)],
    existing: Option<&str>,
) -> Option<String> {
    let mut names: Vec<&str> = Vec::new();
    let mut parts: Vec<String> = existing
        .filter(|e| !e.is_empty())
        .map(|e| vec![e.to_owned()])
        .unwrap_or_default();
    for (name, value) in env {
        let name = name.as_ref();
        if !forwarded(name) || names.contains(&name) {
            continue;
        }
        names.push(name);
        let flag = if windows_path(&value.as_ref().to_string_lossy()) {
            "up"
        } else {
            "u"
        };
        parts.push(format!("{name}/{flag}"));
    }
    (!parts.is_empty()).then(|| parts.join(":"))
}

fn forwarded(name: &str) -> bool {
    let mut bytes = name.bytes();
    let head = bytes
        .next()
        .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_');
    head && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
        && !name.eq_ignore_ascii_case("PATH")
        && name != "XDEV_CLI"
        && !name.eq_ignore_ascii_case("WSLENV")
}

fn windows_path(value: &str) -> bool {
    let b = value.as_bytes();
    let drive =
        b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'\\' | b'/');
    drive || value.starts_with(r"\\")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles::{Cli, builtin};

    fn linux(distro: &str, path: &str) -> WslCwd {
        WslCwd::Linux {
            distro: distro.to_owned(),
            path: path.to_owned(),
        }
    }

    #[test]
    fn drive_paths_pass_as_they_are() {
        let w = |p: &str| WslCwd::Windows(p.to_owned());
        assert_eq!(cwd_for(r"C:\src\app"), Ok(w(r"C:\src\app")));
        assert_eq!(cwd_for("c:/src/app"), Ok(w(r"c:\src\app")));
        assert_eq!(cwd_for(r"\\?\C:\src"), Ok(w(r"C:\src")));
        assert_eq!(cwd_for(r"C:\src\app").unwrap().cd(), r"C:\src\app");
    }

    #[test]
    fn wsl_shares_become_linux_paths() {
        assert_eq!(
            cwd_for(r"\\wsl$\Ubuntu\home\u\app\"),
            Ok(linux("Ubuntu", "/home/u/app"))
        );
        assert_eq!(cwd_for(r"\\WSL.LOCALHOST\Ubuntu"), Ok(linux("Ubuntu", "/")));
        assert_eq!(cwd_for("//wsl$/Ubuntu/x"), Ok(linux("Ubuntu", "/x")));
        assert_eq!(cwd_for(r"\\?\UNC\wsl$\Ubuntu\x"), Ok(linux("Ubuntu", "/x")));
        assert_eq!(
            cwd_for(r"\\wsl$\Ubuntu\a b\ü"),
            Ok(linux("Ubuntu", "/a b/ü"))
        );
        assert_eq!(cwd_for(r"\\wsl$\Ubuntu\x").unwrap().cd(), "/x");
    }

    #[test]
    fn other_paths_are_refused() {
        for path in [r"\\server\share\x", r"src\app", "C:", r"\\wsl$\"] {
            assert_eq!(cwd_for(path), Err(WslPathError), "{path}");
        }
    }

    #[test]
    fn distro_names() {
        for ok in ["Ubuntu-22.04", "my_distro", "A"] {
            assert!(valid_distro(ok), "{ok}");
        }
        let long = "a".repeat(65);
        for bad in ["", "-x", "a b", "a;b", long.as_str()] {
            assert!(!valid_distro(bad), "{bad}");
        }
        assert!(valid_distro(&"a".repeat(64)));
    }

    #[test]
    fn program_of_a_profile() {
        let claude = builtin(Cli::Claude);
        assert_eq!(
            program(&claude),
            Some(PathBuf::from(spec(Cli::Claude).commands[0]))
        );
        let mut custom = Profile {
            id: "mine".into(),
            cli: None,
            program: Some(" mytool ".into()),
            ..builtin(Cli::Claude)
        };
        assert_eq!(program(&custom), Some(PathBuf::from("mytool")));
        custom.program = None;
        assert_eq!(program(&custom), None);
    }

    #[test]
    fn script_quotes_each_argument() {
        assert_eq!(
            script(&["source ~/.nvm/nvm.sh"], "claude", &["--model", "it's"]),
            "source ~/.nvm/nvm.sh\nexec 'claude' '--model' 'it'\\''s'"
        );
        assert_eq!(script::<&str, &str>(&[], "claude", &[]), "exec 'claude'");
    }

    fn decode(text: &str) -> Vec<u8> {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = Vec::new();
        for chunk in text.as_bytes().chunks(4) {
            let mut n = 0u32;
            let mut len = 0;
            for (i, c) in chunk.iter().enumerate() {
                if *c == b'=' {
                    break;
                }
                let v = ALPHABET.iter().position(|a| a == c).unwrap() as u32;
                n |= v << (18 - 6 * i);
                len = i;
            }
            for i in 0..len {
                out.push((n >> (16 - 8 * i)) as u8);
            }
        }
        out
    }

    #[test]
    fn argv_carries_the_script_as_base64() {
        let args = ["--model", "it's", "a \"b\" $c"];
        let startup = ["source ~/.nvm/nvm.sh"];
        let a = argv("Ubuntu", "/home/u/app", "claude", &args, &startup);
        assert_eq!(
            a[..9],
            [
                "-d",
                "Ubuntu",
                "--cd",
                "/home/u/app",
                "--exec",
                "sh",
                "-c",
                BOOT,
                "xdev"
            ]
        );
        assert_eq!(a.len(), 10);
        let decoded = String::from_utf8(decode(&a[9])).unwrap();
        assert_eq!(decoded, script(&startup, "claude", &args));
    }

    #[test]
    fn boot_is_one_line() {
        assert!(BOOT.contains("base64 -d"));
        assert!(BOOT.contains("-l -i -c"));
        assert!(BOOT.contains("/bin/sh"));
        assert!(!BOOT.contains('\n'));
    }

    #[test]
    fn wslenv_lists_names_once() {
        let env = [
            ("FOO", "1"),
            ("ROOT", "C:\\x"),
            ("SHARE", "\\\\srv\\s"),
            ("PATH", "a"),
            ("Path", "b"),
            ("XDEV_CLI", "c"),
            ("A:B", "1"),
            ("FOO", "2"),
        ];
        assert_eq!(
            wslenv(&env, None).as_deref(),
            Some("FOO/u:ROOT/up:SHARE/up")
        );
        assert_eq!(
            wslenv(&env, Some("X/p")).as_deref(),
            Some("X/p:FOO/u:ROOT/up:SHARE/up")
        );
        assert_eq!(wslenv::<&str, &str>(&[], None), None);
        assert_eq!(wslenv(&[("WSLENV", "x"), ("1A", "y")], None), None);
    }

    #[test]
    fn label_keys_the_distro() {
        assert_eq!(label("Ubuntu", "claude"), "wsl:Ubuntu:claude");
    }
}
