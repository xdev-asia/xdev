//! Shell integration: bash, zsh, fish and PowerShell opened by xDev load a script that marks each
//! prompt, the command's start and its exit code (OSC 133 A/B/C/D) and reports the folder (OSC 7).
//! The script comes in through an argument or an environment variable, and reads the owner's own
//! rc files; those are never changed. Settings → Terminal → Shell integration turns it off.

use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use xdev_agent::Launch;

/// The folder under the data dir the scripts are written to.
const DIR: &str = "shell-integration";

const BASH: &str = include_str!("../shell-integration/bash.sh");
const ZSH: [(&str, &str); 4] = [
    (".zshenv", include_str!("../shell-integration/zsh/.zshenv")),
    (
        ".zprofile",
        include_str!("../shell-integration/zsh/.zprofile"),
    ),
    (".zshrc", include_str!("../shell-integration/zsh/.zshrc")),
    (".zlogin", include_str!("../shell-integration/zsh/.zlogin")),
];
const FISH: &str = include_str!("../shell-integration/fish/vendor_conf.d/xdev.fish");
const PWSH: &str = include_str!("../shell-integration/pwsh.ps1");

/// Where fish looks when `XDG_DATA_DIRS` is not set.
const XDG_DATA_DIRS_DEFAULT: &str = "/usr/local/share:/usr/share";

/// The args a shell starts with, and the variables set for it.
type Plan = (Vec<String>, Vec<(String, OsString)>);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Shell {
    Bash,
    Zsh,
    Fish,
    Pwsh,
}

/// The shell `program` is, when xDev has a script for it. On Windows zsh and fish are left alone,
/// and so is the `bash.exe` that starts WSL: the script path would not be one Linux can read.
fn shell_of(program: &Path, windows: bool) -> Option<Shell> {
    let stem = program.file_stem()?.to_str()?.to_ascii_lowercase();
    match stem.as_str() {
        "bash" if !windows => Some(Shell::Bash),
        "bash" => {
            let path = program
                .to_string_lossy()
                .replace('\\', "/")
                .to_ascii_lowercase();
            let wsl = path.contains("/system32/") || path.contains("/windowsapps/");
            (program.is_absolute() && !wsl).then_some(Shell::Bash)
        }
        "zsh" if !windows => Some(Shell::Zsh),
        "fish" if !windows => Some(Shell::Fish),
        "pwsh" | "powershell" => Some(Shell::Pwsh),
        _ => None,
    }
}

/// The new args and the variables to set for `shell` started with `args`; `None` when the args
/// do more than open an interactive shell (a command, a script), which is then left as it is.
fn plan(
    shell: Shell,
    args: &[String],
    dir: &Path,
    windows: bool,
    var: &dyn Fn(&str) -> Option<OsString>,
) -> Option<Plan> {
    let unix_plain = || {
        args.iter()
            .all(|a| matches!(a.as_str(), "-l" | "--login" | "-i"))
    };
    let set = |name: Option<OsString>| name.filter(|v| !v.is_empty());
    match shell {
        Shell::Bash => {
            if !unix_plain() {
                return None;
            }
            // A login shell ignores `--init-file`, so the script reads the login files itself.
            let login = args.iter().any(|a| a == "-l" || a == "--login");
            let mut path = dir.join("bash.sh").to_string_lossy().into_owned();
            if windows {
                path = path.replace('\\', "/");
            }
            let mut out = vec!["--init-file".to_owned(), path];
            if args.iter().any(|a| a == "-i") {
                out.push("-i".to_owned());
            }
            let env = if login {
                vec![("XDEV_SHELL_LOGIN".to_owned(), OsString::from("1"))]
            } else {
                Vec::new()
            };
            Some((out, env))
        }
        Shell::Zsh => {
            if !unix_plain() {
                return None;
            }
            let mut env = vec![("ZDOTDIR".to_owned(), dir.join("zsh").into_os_string())];
            if let Some(own) = set(var("ZDOTDIR")) {
                env.push(("XDEV_ZDOTDIR".to_owned(), own));
            }
            Some((args.to_vec(), env))
        }
        Shell::Fish => {
            if !unix_plain() {
                return None;
            }
            let own = set(var("XDG_DATA_DIRS"));
            // fish reads `<entry>/fish/vendor_conf.d`, so the entry is the folder that holds `fish/`.
            let mut dirs = dir.as_os_str().to_owned();
            dirs.push(":");
            dirs.push(own.clone().unwrap_or_else(|| XDG_DATA_DIRS_DEFAULT.into()));
            let env = vec![
                ("XDG_DATA_DIRS".to_owned(), dirs),
                ("XDEV_XDG_DATA_DIRS".to_owned(), own.unwrap_or_default()),
            ];
            Some((args.to_vec(), env))
        }
        Shell::Pwsh => {
            let flag = |a: &String| a.to_ascii_lowercase();
            let plain = args.iter().all(|a| {
                matches!(
                    flag(a).as_str(),
                    "-nologo" | "-noprofile" | "-login" | "-l" | "-noexit" | "-mta" | "-sta"
                )
            });
            if !plain {
                return None;
            }
            // As base64 of UTF-16LE, so no layer of quoting touches it, and a file is not needed:
            // an execution policy that stops scripts does not stop it.
            let utf16: Vec<u8> = PWSH
                .replace('\r', "")
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect();
            let mut out = args.to_vec();
            if !args.iter().any(|a| flag(a) == "-noexit") {
                out.push("-NoExit".to_owned());
            }
            out.push("-EncodedCommand".to_owned());
            out.push(base64::engine::general_purpose::STANDARD.encode(utf16));
            Some((out, Vec::new()))
        }
    }
}

/// The files `shell` reads, relative to the scripts' folder.
fn files(shell: Shell) -> Vec<(PathBuf, &'static str)> {
    match shell {
        Shell::Bash => vec![(PathBuf::from("bash.sh"), BASH)],
        Shell::Zsh => ZSH
            .iter()
            .map(|(name, text)| (Path::new("zsh").join(name), *text))
            .collect(),
        Shell::Fish => vec![(
            Path::new("fish").join("vendor_conf.d").join("xdev.fish"),
            FISH,
        )],
        Shell::Pwsh => Vec::new(),
    }
}

/// Writes the scripts `shell` reads under `dir`, each only when it differs from what is there.
fn prepare(dir: &Path, shell: Shell) -> io::Result<()> {
    for (rel, text) in files(shell) {
        let path = dir.join(rel);
        let text = text.replace('\r', "");
        if fs::read(&path).is_ok_and(|have| have == text.as_bytes()) {
            continue;
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        crate::atomic::write_atomic(&path, text.as_bytes())?;
    }
    Ok(())
}

/// Makes the shell `launch` opens load its script from under `data_dir`. Anything that is not a
/// plain interactive bash, zsh, fish or PowerShell, or whose script cannot be written, is left as
/// it is. True when the launch was changed.
pub(crate) fn apply(launch: &mut Launch, data_dir: &Path) -> bool {
    let is_shell = launch.profile == "shell" || launch.profile.starts_with("shell:");
    if !is_shell || launch.agent || !launch.startup.is_empty() || !launch.prompt_argv.is_empty() {
        return false;
    }
    let windows = cfg!(windows);
    let Some(shell) = shell_of(&launch.program, windows) else {
        return false;
    };
    let dir = data_dir.join(DIR);
    let own = launch.env.clone();
    let var = |name: &str| {
        own.iter()
            .rev()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.clone())
            .or_else(|| std::env::var_os(name))
    };
    let Some((args, env)) = plan(shell, &launch.args, &dir, windows, &var) else {
        return false;
    };
    if let Err(e) = prepare(&dir, shell) {
        eprintln!("shell integration: {e}");
        return false;
    }
    launch.args = args;
    for (name, value) in env {
        launch.env.retain(|(k, _)| *k != name);
        launch.env.push((name, value));
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| (*s).to_owned()).collect()
    }

    fn none(_: &str) -> Option<OsString> {
        None
    }

    fn shell_launch(program: &str, a: &[&str]) -> Launch {
        Launch {
            profile: "shell:login".into(),
            program: PathBuf::from(program),
            args: args(a),
            env: Vec::new(),
            agent: false,
            permissions: xdev_agent::Permissions::Ask,
            account: None,
            account_source: None,
            startup: Vec::new(),
            cli: None,
            hooks: false,
            hook_events: Vec::new(),
            prompt_after: None,
            prompt_argv: Vec::new(),
        }
    }

    #[test]
    fn knows_the_four_shells_and_leaves_the_rest() {
        let unix = |p: &str| shell_of(Path::new(p), false);
        assert_eq!(unix("/bin/bash"), Some(Shell::Bash));
        assert_eq!(unix("/usr/bin/zsh"), Some(Shell::Zsh));
        assert_eq!(unix("/opt/homebrew/bin/fish"), Some(Shell::Fish));
        assert_eq!(unix("/usr/local/bin/pwsh"), Some(Shell::Pwsh));
        for other in ["/bin/sh", "/bin/dash", "/usr/bin/ssh", "/bin/tcsh"] {
            assert_eq!(unix(other), None, "{other}");
        }
        let win = |p: &str| shell_of(Path::new(p), true);
        assert_eq!(win("powershell.exe"), Some(Shell::Pwsh));
        assert_eq!(
            win("C:/Program Files/PowerShell/7/pwsh.exe"),
            Some(Shell::Pwsh)
        );
        for other in ["cmd.exe", "wsl.exe", "zsh.exe", "fish.exe", "bash.exe"] {
            assert_eq!(win(other), None, "{other}");
        }
        // WSL's launcher is not Git Bash.
        assert_eq!(win("C:/Windows/System32/bash.exe"), None);
    }

    #[test]
    fn bash_reads_the_script_and_still_logs_in() {
        let dir = Path::new("/d/shell-integration");
        let script = dir.join("bash.sh").to_string_lossy().into_owned();
        let (a, env) = plan(Shell::Bash, &args(&["-l"]), dir, false, &none).unwrap();
        assert_eq!(a, args(&["--init-file", &script]));
        assert_eq!(
            env,
            vec![("XDEV_SHELL_LOGIN".to_owned(), OsString::from("1"))]
        );
        let (a, env) = plan(Shell::Bash, &args(&["-i"]), dir, false, &none).unwrap();
        assert_eq!(a, args(&["--init-file", &script, "-i"]));
        assert!(env.is_empty());
        // A command or a script runs as it was asked.
        assert_eq!(
            plan(Shell::Bash, &args(&["-c", "ls"]), dir, false, &none),
            None
        );
        assert_eq!(plan(Shell::Bash, &args(&["x.sh"]), dir, false, &none), None);
        // Git Bash takes the path with forward slashes.
        let (a, _) = plan(Shell::Bash, &[], Path::new(r"C:\d"), true, &none).unwrap();
        assert_eq!(a, args(&["--init-file", "C:/d/bash.sh"]));
    }

    #[test]
    fn zsh_and_fish_keep_the_owners_folders() {
        let dir = Path::new("/d/si");
        let (a, env) = plan(Shell::Zsh, &args(&["-l"]), dir, false, &none).unwrap();
        assert_eq!(a, args(&["-l"]));
        assert_eq!(
            env,
            vec![("ZDOTDIR".to_owned(), dir.join("zsh").into_os_string())]
        );
        let own = |k: &str| (k == "ZDOTDIR").then(|| OsString::from("/home/u/.config/zsh"));
        let (_, env) = plan(Shell::Zsh, &[], dir, false, &own).unwrap();
        assert_eq!(
            env[1],
            ("XDEV_ZDOTDIR".to_owned(), "/home/u/.config/zsh".into())
        );

        let fish = dir.to_string_lossy().into_owned();
        assert!(
            Path::new(&fish)
                .join("fish/vendor_conf.d")
                .ends_with("si/fish/vendor_conf.d")
        );
        let (_, env) = plan(Shell::Fish, &args(&["-l"]), dir, false, &none).unwrap();
        assert_eq!(
            env,
            vec![
                (
                    "XDG_DATA_DIRS".to_owned(),
                    OsString::from(format!("{fish}:/usr/local/share:/usr/share"))
                ),
                ("XDEV_XDG_DATA_DIRS".to_owned(), OsString::new()),
            ]
        );
        let own = |k: &str| (k == "XDG_DATA_DIRS").then(|| OsString::from("/nix/share"));
        let (_, env) = plan(Shell::Fish, &[], dir, false, &own).unwrap();
        assert_eq!(env[0].1, OsString::from(format!("{fish}:/nix/share")));
        assert_eq!(env[1].1, OsString::from("/nix/share"));
        assert_eq!(
            plan(Shell::Fish, &args(&["-c", "ls"]), dir, false, &none),
            None
        );
    }

    #[test]
    fn powershell_runs_the_script_after_the_profile_and_stays_open() {
        let dir = Path::new("C:/d");
        let (a, env) = plan(Shell::Pwsh, &args(&["-NoLogo"]), dir, true, &none).unwrap();
        assert_eq!(a[..3], args(&["-NoLogo", "-NoExit", "-EncodedCommand"]));
        assert!(env.is_empty());
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&a[3])
            .unwrap();
        let units: Vec<u16> = bytes
            .chunks(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        let script = String::from_utf16(&units).unwrap();
        assert!(script.contains("133;D") && script.contains("]7;file://"));
        assert!(!script.contains('\r'));
        let (a, _) = plan(Shell::Pwsh, &args(&["-noexit"]), dir, true, &none).unwrap();
        assert_eq!(a[..2], args(&["-noexit", "-EncodedCommand"]));
        for busy in [&["-Command", "ls"][..], &["-File", "x.ps1"], &["-c", "ls"]] {
            assert_eq!(plan(Shell::Pwsh, &args(busy), dir, true, &none), None);
        }
    }

    #[test]
    fn the_scripts_report_prompts_exit_codes_and_the_folder() {
        for text in [BASH, ZSH[2].1, FISH, PWSH] {
            for mark in ["133;A", "133;B", "133;C", "133;D", "]7;file://"] {
                assert!(text.contains(mark), "{mark}");
            }
        }
    }

    #[test]
    fn prepare_writes_each_file_once() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(DIR);
        prepare(&dir, Shell::Zsh).unwrap();
        for name in [".zshenv", ".zprofile", ".zshrc", ".zlogin"] {
            let text = fs::read_to_string(dir.join("zsh").join(name)).unwrap();
            assert!(
                text.contains("XDEV_ZDOTDIR") && !text.contains('\r'),
                "{name}"
            );
        }
        let bash = dir.join("bash.sh");
        prepare(&dir, Shell::Bash).unwrap();
        // A changed file is put back; one that matches is not written again.
        fs::write(&bash, "old").unwrap();
        prepare(&dir, Shell::Bash).unwrap();
        assert_eq!(fs::read_to_string(&bash).unwrap(), BASH.replace('\r', ""));
        let before = fs::metadata(&bash).unwrap().modified().unwrap();
        prepare(&dir, Shell::Bash).unwrap();
        assert_eq!(fs::metadata(&bash).unwrap().modified().unwrap(), before);
        prepare(&dir, Shell::Fish).unwrap();
        assert!(dir.join("fish/vendor_conf.d/xdev.fish").is_file());
    }

    #[test]
    fn apply_changes_only_a_plain_shell() {
        let tmp = tempfile::tempdir().unwrap();
        let pwsh = if cfg!(windows) {
            "powershell.exe"
        } else {
            "/usr/bin/pwsh"
        };
        let mut shell = shell_launch(pwsh, &["-NoLogo"]);
        assert!(apply(&mut shell, tmp.path()));
        assert!(shell.args.iter().any(|a| a == "-EncodedCommand"));

        let mut agent = shell_launch(pwsh, &["-NoLogo"]);
        agent.profile = "claude".into();
        assert!(!apply(&mut agent, tmp.path()));
        let mut startup = shell_launch(pwsh, &["-NoLogo"]);
        startup.startup = vec!["cd x".into()];
        assert!(!apply(&mut startup, tmp.path()));
        let mut cmd = shell_launch("cmd.exe", &[]);
        assert!(!apply(&mut cmd, tmp.path()));
        assert_eq!(cmd.args, Vec::<String>::new());
    }

    #[cfg(unix)]
    #[test]
    fn apply_sets_the_variables_over_the_launchs_own() {
        let tmp = tempfile::tempdir().unwrap();
        let mut zsh = shell_launch("/bin/zsh", &["-l"]);
        zsh.env.push(("ZDOTDIR".into(), "/home/u/z".into()));
        assert!(apply(&mut zsh, tmp.path()));
        let get = |k: &str| zsh.env.iter().filter(|(n, _)| n == k).count();
        assert_eq!((get("ZDOTDIR"), get("XDEV_ZDOTDIR")), (1, 1));
        assert!(tmp.path().join(DIR).join("zsh/.zshrc").is_file());
    }

    /// A real bash, when there is one, parses the script.
    #[cfg(unix)]
    #[test]
    fn bash_parses_the_script() {
        let Some(bash) = ["/bin/bash", "/usr/bin/bash"]
            .iter()
            .map(PathBuf::from)
            .find(|p| p.is_file())
        else {
            return;
        };
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(DIR);
        prepare(&dir, Shell::Bash).unwrap();
        let status = std::process::Command::new(bash)
            .arg("-n")
            .arg(dir.join("bash.sh"))
            .status()
            .unwrap();
        assert!(status.success());
    }
}
