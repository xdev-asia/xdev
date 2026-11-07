//! Settings -> Terminal -> PowerShell version: which program a PowerShell tab starts on Windows.

use std::path::PathBuf;

use xdev_agent::Launch;

use crate::settings::WindowsPowershell;

/// The file name of `program`, lower case; both `/` and `\` split, whatever the host OS.
fn file_name(program: &std::path::Path) -> String {
    let text = program.to_string_lossy();
    text.rsplit(|c| c == '/' || c == char::from(92u8))
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
}

/// Whether `launch` is the built-in PowerShell shell entry: a shell tab (not an agent) whose
/// program is `pwsh.exe` or `powershell.exe` with the entry's own `-NoLogo` argument. A custom
/// shell, with any other arguments, is left to its owner.
fn is_builtin_powershell(launch: &Launch) -> bool {
    !launch.agent
        && (launch.profile == "shell" || launch.profile == "shell:powershell")
        && matches!(
            file_name(&launch.program).as_str(),
            "pwsh.exe" | "powershell.exe"
        )
        && launch.args == ["-NoLogo"]
}

/// Puts the chosen PowerShell in `launch.program` when `launch` is the built-in PowerShell
/// entry. `Auto` leaves it as it is; `Pwsh` falls back to `powershell.exe` when `find` has no
/// `pwsh.exe`.
pub(crate) fn apply(
    launch: &mut Launch,
    choice: WindowsPowershell,
    find: &dyn Fn(&str) -> Option<PathBuf>,
) {
    if choice == WindowsPowershell::Auto || !is_builtin_powershell(launch) {
        return;
    }
    launch.program = match choice {
        WindowsPowershell::Auto => return,
        WindowsPowershell::Windows => PathBuf::from("powershell.exe"),
        WindowsPowershell::Pwsh => {
            find("pwsh.exe").unwrap_or_else(|| PathBuf::from("powershell.exe"))
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launch(profile: &str, program: &str, args: &[&str], agent: bool) -> Launch {
        Launch {
            profile: profile.into(),
            program: PathBuf::from(program),
            args: args.iter().map(|s| (*s).to_owned()).collect(),
            env: Vec::new(),
            agent,
            permissions: xdev_agent::Permissions::Ask,
            account: None,
            account_source: None,
            startup: Vec::new(),
            cli: None,
            hooks: false,
            hook_events: Vec::new(),
            prompt_after: None,
            prompt_argv: Vec::new(),
            wsl: None,
        }
    }

    const PWSH: &str = r"C:\Program Files\PowerShell\7\pwsh.exe";

    fn found(_: &str) -> Option<PathBuf> {
        Some(PathBuf::from(PWSH))
    }

    fn missing(_: &str) -> Option<PathBuf> {
        None
    }

    #[test]
    fn auto_keeps_the_launch() {
        let mut l = launch("shell", PWSH, &["-NoLogo"], false);
        apply(&mut l, WindowsPowershell::Auto, &found);
        assert_eq!(l.program, PathBuf::from(PWSH));
    }

    #[test]
    fn windows_choice_picks_windows_powershell() {
        let mut l = launch("shell:powershell", PWSH, &["-NoLogo"], false);
        apply(&mut l, WindowsPowershell::Windows, &found);
        assert_eq!(l.program, PathBuf::from("powershell.exe"));
    }

    #[test]
    fn pwsh_choice_uses_the_found_program() {
        let mut l = launch("shell", "powershell.exe", &["-NoLogo"], false);
        apply(&mut l, WindowsPowershell::Pwsh, &found);
        assert_eq!(l.program, PathBuf::from(PWSH));
    }

    #[test]
    fn pwsh_choice_falls_back_when_missing() {
        let mut l = launch("shell", "powershell.exe", &["-NoLogo"], false);
        apply(&mut l, WindowsPowershell::Pwsh, &missing);
        assert_eq!(l.program, PathBuf::from("powershell.exe"));
    }

    #[test]
    fn custom_and_agent_launches_are_untouched() {
        for l in [
            launch("shell:my-ps", PWSH, &["-NoLogo"], false),
            launch("shell:powershell", PWSH, &["-NoProfile"], false),
            launch("shell:powershell", PWSH, &["-NoLogo"], true),
            launch("shell:powershell", "cmd.exe", &["-NoLogo"], false),
        ] {
            let mut changed = l.clone();
            apply(&mut changed, WindowsPowershell::Windows, &found);
            assert_eq!(changed.program, l.program, "{}", l.profile);
        }
    }
}
