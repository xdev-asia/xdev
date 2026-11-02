//! What a terminal runs: the user's shell or an agent CLI, by profile id.

use std::env;
use std::ffi::OsString;
use std::path::PathBuf;

use xdev_ai::{AiError, claude_command, codex_command};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub profile: String,
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, OsString)>,
    /// An agent launch goes through the policy gate; a shell does not.
    pub agent: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum LaunchError {
    #[error("unknown profile")]
    UnknownProfile,
    /// Carries the CLI's `AiError` code.
    #[error("agent CLI is not installed ({0})")]
    NotInstalled(&'static str),
}

impl LaunchError {
    pub fn code(&self) -> &'static str {
        match self {
            LaunchError::UnknownProfile => "unknown_profile",
            LaunchError::NotInstalled(code) => code,
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
