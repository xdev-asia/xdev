//! `xdev skills get|install`: the orchestration guide and the skill install.
//! Local; the app need not run.

use std::io::Write;
use std::path::{Path, PathBuf};

use clap::Subcommand;
use xdev_kit::Agent;
use xdev_orch::{InstallOpts, InstallReport, SkillEnv, guide, skills};

use crate::Outcome;

#[derive(Subcommand)]
pub enum SkillsCommand {
    /// Print a guide built into this binary (`orchestration`).
    Get {
        topic: String,
        /// Print one deeper topic instead.
        #[arg(long, conflicts_with = "references")]
        reference: Option<String>,
        /// List the deeper topics.
        #[arg(long)]
        references: bool,
    },
    /// Write the orchestration skill where the agent CLIs read it.
    Install {
        /// Replace copies that were edited, after a backup.
        #[arg(long)]
        force: bool,
        /// Say what would change; change nothing.
        #[arg(long)]
        dry_run: bool,
    },
}

/// The text `get` prints, or the name of what was not found.
pub fn get_text(topic: &str, reference: Option<&str>, references: bool) -> Result<String, String> {
    let main = guide::get(topic).ok_or_else(|| format!("no guide named {topic}"))?;
    if references {
        return Ok(guide::references(topic).join("\n") + "\n");
    }
    match reference {
        Some(name) => guide::reference(topic, name)
            .map(str::to_owned)
            .ok_or_else(|| format!("no reference named {name}")),
        None => Ok(main.to_owned()),
    }
}

/// One line per target: `action<TAB>how<TAB>agent<TAB>dir`.
pub fn plain(report: &InstallReport) -> String {
    let mut out = String::new();
    for t in &report.targets {
        let action = serde_json::to_value(t.action)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default();
        let how = serde_json::to_value(t.how)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default();
        out.push_str(&format!("{action}\t{how}\t{}\t{}\n", t.agent, t.dir));
    }
    if let Some(b) = &report.backup {
        out.push_str(&format!("backup\t{b}\n"));
    }
    out
}

/// The folders the install works on, from the process environment.
pub fn env_of(data_dir: &Path) -> Result<SkillEnv, &'static str> {
    let user_home = ["USERPROFILE", "HOME"]
        .into_iter()
        .find_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty()))
        .map(PathBuf::from)
        .ok_or("io")?;
    let process_env = |k: &str| std::env::var(k).ok();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
    Ok(SkillEnv {
        claude_homes: xdev_kit::homes(data_dir, &user_home, &process_env)
            .into_iter()
            .filter(|h| h.agent == Agent::Claude)
            .map(|h| h.path)
            .collect(),
        user_home,
        data_dir: data_dir.to_owned(),
        now_ms,
    })
}

pub fn run(command: SkillsCommand, data_dir: &Path) -> Result<Outcome, &'static str> {
    match command {
        SkillsCommand::Get {
            topic,
            reference,
            references,
        } => match get_text(&topic, reference.as_deref(), references) {
            Ok(text) => {
                // A closed pipe (`| head`) is not an error.
                let _ = std::io::stdout().write_all(text.as_bytes());
                Ok(Outcome::Ok)
            }
            Err(msg) => {
                eprintln!("error: {msg}");
                Ok(Outcome::Exit(5))
            }
        },
        SkillsCommand::Install { force, dry_run } => {
            let env = env_of(data_dir)?;
            let report = skills::install(
                &env,
                InstallOpts {
                    force,
                    dry_run,
                    only_outdated: false,
                },
                &skills::system_link,
            )
            .map_err(|_| "io")?;
            print!("{}", plain(&report));
            Ok(Outcome::Ok)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_prints_the_guide_a_reference_or_the_reference_names() {
        let main = get_text("orchestration", None, false).unwrap();
        assert!(main.starts_with("# xDev orchestration"));
        let names = get_text("orchestration", None, true).unwrap();
        assert!(names.lines().any(|l| l == "placement"));
        let placement = get_text("orchestration", Some("placement"), false).unwrap();
        assert!(placement.starts_with("# Placement"));
        assert!(get_text("orchestration", Some("nope"), false).is_err());
        assert!(get_text("nope", None, false).is_err());
    }

    #[test]
    fn install_text_has_one_line_per_target() {
        let dir = tempfile::tempdir().unwrap();
        let env = SkillEnv {
            user_home: dir.path().join("home"),
            claude_homes: vec![],
            data_dir: dir.path().join("data"),
            now_ms: 7,
        };
        let r = skills::install(&env, InstallOpts::default(), &skills::system_link).unwrap();
        let text = plain(&r);
        assert_eq!(text.lines().count(), 1);
        assert!(text.starts_with("created\twritten\tcodex\t"));
    }
}
