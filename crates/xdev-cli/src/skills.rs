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
    /// List the guides built into this binary.
    List {
        #[arg(long)]
        json: bool,
    },
    /// Print a guide built into this binary (`orchestration`, `cli`).
    #[command(visible_alias = "show")]
    Get {
        topic: String,
        /// Print one deeper topic instead; a bare name or `references/<name>.md`.
        #[arg(long, conflicts_with_all = ["references", "full"])]
        reference: Option<String>,
        /// List the deeper topics.
        #[arg(long, conflicts_with = "full")]
        references: bool,
        /// The guide and every reference.
        #[arg(long)]
        full: bool,
        /// Print `{topic, skill, summary, content, references}`.
        #[arg(long)]
        json: bool,
    },
    /// Write the bundled skills where the agent CLIs read them.
    Install {
        /// Only this skill (a topic or folder name); repeat for more.
        #[arg(long = "skill")]
        skills: Vec<String>,
        /// Replace copies that were edited, after a backup.
        #[arg(long)]
        force: bool,
        /// Say what would change; change nothing.
        #[arg(long)]
        dry_run: bool,
        #[arg(long)]
        json: bool,
    },
    /// Refresh copies that are already installed; never adds one.
    Update {
        /// Only this skill (a topic or folder name); repeat for more.
        #[arg(long = "skill")]
        skills: Vec<String>,
        /// Replace copies that were edited, after a backup.
        #[arg(long)]
        force: bool,
        /// Say what would change; change nothing.
        #[arg(long)]
        dry_run: bool,
        #[arg(long)]
        json: bool,
    },
}

/// The text `get` prints, or the name of what was not found.
pub fn get_text(
    topic: &str,
    reference: Option<&str>,
    references: bool,
    full: bool,
) -> Result<String, String> {
    let main = guide::get(topic).ok_or_else(|| format!("no guide named {topic}"))?;
    if references {
        return Ok(guide::references(topic).join("\n") + "\n");
    }
    if full {
        return guide::full(topic).ok_or_else(|| format!("no guide named {topic}"));
    }
    match reference {
        Some(name) => guide::reference(topic, name)
            .map(str::to_owned)
            .ok_or_else(|| format!("no reference named {name}")),
        None => Ok(main.to_owned()),
    }
}

/// One line per bundled guide: `topic<TAB>skill<TAB>summary`.
pub fn list_text() -> String {
    guide::BUNDLED
        .iter()
        .map(|b| format!("{}\t{}\t{}\n", b.topic, b.skill, b.summary))
        .collect()
}

fn list_json() -> serde_json::Value {
    let topics: Vec<_> = guide::BUNDLED
        .iter()
        .map(|b| serde_json::json!({"name": b.topic, "skill": b.skill, "summary": b.summary}))
        .collect();
    serde_json::json!({ "topics": topics })
}

/// `{topic, skill, summary, content, references}` of one guide.
fn get_json(topic: &str, content: String) -> serde_json::Value {
    // `get_text` already found the guide.
    let b = guide::find(topic);
    serde_json::json!({
        "topic": b.map(|b| b.topic),
        "skill": b.map(|b| b.skill),
        "summary": b.map(|b| b.summary),
        "content": content,
        "references": guide::references(topic),
    })
}

/// One line per target: `action<TAB>how<TAB>agent<TAB>dir<TAB>skill`.
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
        out.push_str(&format!(
            "{action}\t{how}\t{}\t{}\t{}\n",
            t.agent, t.dir, t.skill
        ));
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
        SkillsCommand::List { json } => {
            let text = if json {
                list_json().to_string() + "\n"
            } else {
                list_text()
            };
            // A closed pipe (`| head`) is not an error.
            let _ = std::io::stdout().write_all(text.as_bytes());
            Ok(Outcome::Ok)
        }
        SkillsCommand::Get {
            topic,
            reference,
            references,
            full,
            json,
        } => match get_text(&topic, reference.as_deref(), references, full) {
            Ok(text) => {
                let text = if json {
                    get_json(&topic, text).to_string() + "\n"
                } else {
                    text
                };
                let _ = std::io::stdout().write_all(text.as_bytes());
                Ok(Outcome::Ok)
            }
            Err(msg) => {
                eprintln!("error: {msg}");
                Ok(Outcome::Exit(5))
            }
        },
        SkillsCommand::Install {
            skills,
            force,
            dry_run,
            json,
        } => change(data_dir, &skills, force, dry_run, json, false),
        SkillsCommand::Update {
            skills,
            force,
            dry_run,
            json,
        } => change(data_dir, &skills, force, dry_run, json, true),
    }
}

/// The bundled skills named, or every one when none is; `Err` names the
/// first that does not exist.
fn select(names: &[String]) -> Result<Vec<&'static guide::Bundled>, String> {
    if names.is_empty() {
        return Ok(guide::BUNDLED.iter().collect());
    }
    let mut out: Vec<&'static guide::Bundled> = Vec::new();
    for n in names {
        let b = guide::find(n).ok_or_else(|| format!("no skill named {n}"))?;
        if !out.iter().any(|o| o.skill == b.skill) {
            out.push(b);
        }
    }
    Ok(out)
}

/// `install` (writes what is missing) or `update` (`present_only`).
fn change(
    data_dir: &Path,
    names: &[String],
    force: bool,
    dry_run: bool,
    json: bool,
    present_only: bool,
) -> Result<Outcome, &'static str> {
    let chosen = match select(names) {
        Ok(c) => c,
        Err(msg) => {
            eprintln!("error: {msg}");
            return Ok(Outcome::Exit(5));
        }
    };
    let env = env_of(data_dir)?;
    let opts = InstallOpts {
        force,
        dry_run,
        present_only,
        ..InstallOpts::default()
    };
    let mut report = InstallReport::default();
    for b in chosen {
        let r = skills::install_one(&env, b, opts, &skills::system_link).map_err(|_| "io")?;
        report.targets.extend(r.targets);
        report.backup = report.backup.or(r.backup);
    }
    if json {
        println!("{}", serde_json::to_string(&report).map_err(|_| "io")?);
    } else {
        print!("{}", plain(&report));
    }
    Ok(Outcome::Ok)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_prints_the_guide_a_reference_or_the_reference_names() {
        let main = get_text("orchestration", None, false, false).unwrap();
        assert!(main.starts_with("# xDev orchestration"));
        let names = get_text("orchestration", None, true, false).unwrap();
        assert!(names.lines().any(|l| l == "placement"));
        let placement = get_text("orchestration", Some("placement"), false, false).unwrap();
        assert!(placement.starts_with("# Placement"));
        assert!(get_text("orchestration", Some("nope"), false, false).is_err());
        assert!(get_text("nope", None, false, false).is_err());
    }

    #[test]
    fn install_text_has_one_line_per_target_and_skill() {
        let dir = tempfile::tempdir().unwrap();
        let env = SkillEnv {
            user_home: dir.path().join("home"),
            claude_homes: vec![],
            data_dir: dir.path().join("data"),
            now_ms: 7,
        };
        let r = skills::install(&env, InstallOpts::default(), &skills::system_link).unwrap();
        let text = plain(&r);
        assert_eq!(text.lines().count(), guide::BUNDLED.len());
        assert!(text.starts_with("created\twritten\tcodex\t"));
    }

    #[test]
    fn plain_adds_the_skill_column_last() {
        let report = InstallReport {
            targets: vec![xdev_orch::TargetOutcome {
                skill: "xdev-cli".to_owned(),
                agent: "codex".to_owned(),
                dir: "/d".to_owned(),
                action: xdev_orch::Action::Created,
                how: xdev_orch::How::Written,
            }],
            backup: None,
        };
        assert_eq!(plain(&report), "created\twritten\tcodex\t/d\txdev-cli\n");
    }

    #[test]
    fn select_takes_topics_or_folders_and_rejects_unknown() {
        assert_eq!(select(&[]).unwrap().len(), guide::BUNDLED.len());
        let one = select(&["cli".to_owned(), "xdev-cli".to_owned()]).unwrap();
        assert_eq!(one.len(), 1);
        assert!(select(&["nope".to_owned()]).is_err());
    }

    #[test]
    fn list_has_one_line_per_topic() {
        let text = list_text();
        assert_eq!(text.lines().count(), guide::BUNDLED.len());
        let cli = text.lines().find(|l| l.starts_with("cli\t")).unwrap();
        assert!(cli.starts_with("cli\txdev-cli\t"));
        assert_eq!(cli.split('\t').count(), 3);
        let json = list_json();
        assert_eq!(
            json["topics"].as_array().unwrap().len(),
            guide::BUNDLED.len()
        );
        assert_eq!(json["topics"][1]["skill"], "xdev-cli");
    }

    #[test]
    fn get_full_concatenates() {
        let text = get_text("cli", None, false, true).unwrap();
        let main = get_text("cli", None, false, false).unwrap();
        assert!(text.starts_with(main.trim_end()));
        assert!(text.contains("# Exit codes"));
        assert!(text.len() > main.len());
        let bare = get_text("cli", Some("terminals"), false, false).unwrap();
        let path = get_text("cli", Some("references/terminals.md"), false, false).unwrap();
        assert_eq!(bare, path);
        assert_eq!(get_text("xdev-cli", None, false, false).unwrap(), main);
    }

    #[test]
    fn get_json_has_topic_skill_summary_content_references() {
        let v = get_json("xdev-cli", get_text("cli", None, false, false).unwrap());
        assert_eq!(v["topic"], "cli");
        assert_eq!(v["skill"], "xdev-cli");
        assert!(!v["summary"].as_str().unwrap().is_empty());
        assert!(v["content"].as_str().unwrap().starts_with("# xDev CLI"));
        assert_eq!(
            v["references"],
            serde_json::json!(["worktrees", "terminals", "exit-codes"])
        );
    }
}
