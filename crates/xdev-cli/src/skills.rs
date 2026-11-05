//! `xdev skills get|install`: the orchestration guide and the skill install.
//! Local; the app need not run.

use std::io::Write;
use std::path::{Path, PathBuf};

use clap::Subcommand;
use xdev_kit::Agent;
use xdev_orch::{AGENT_IDS, InstallOpts, InstallReport, SkillEnv, guide, skills};

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
        /// Every bundled skill. This is what no `--skill` means.
        #[arg(long, conflicts_with = "skills")]
        all: bool,
        /// Only this agent (codex, claude, gemini, cursor, factory); repeat for more.
        #[arg(long = "agent")]
        agents: Vec<String>,
        /// Install into the current repository (`.claude/skills`,
        /// `.agents/skills`) instead of your home.
        #[arg(long)]
        local: bool,
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
    /// Remove the copies and links xDev wrote; never a folder it did not write.
    Uninstall {
        /// Only this skill (a topic or folder name); repeat for more.
        #[arg(long = "skill")]
        skills: Vec<String>,
        /// Only this agent (codex, claude, gemini, cursor, factory); repeat for more.
        #[arg(long = "agent")]
        agents: Vec<String>,
        /// Work in the current repository instead of your home.
        #[arg(long)]
        local: bool,
        /// Also remove copies that were edited, after a backup.
        #[arg(long)]
        force: bool,
        /// Say what would be removed; remove nothing.
        #[arg(long)]
        dry_run: bool,
        #[arg(long)]
        json: bool,
    },
    /// Skills the agents on this machine load.
    Installed {
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
        SkillsCommand::Installed { json } => {
            let env = env_of(data_dir)?;
            let process_env = |k: &str| std::env::var(k).ok();
            let homes = xdev_kit::homes(data_dir, &env.user_home, &process_env);
            let worktree = std::env::current_dir()
                .ok()
                .and_then(|d| xdev_core::Repo::discover(&d).ok().map(|r| r.root()));
            let found = installed(&env, &homes, worktree.as_deref());
            let text = if json {
                serde_json::to_string(&found).map_err(|_| "io")? + "\n"
            } else {
                installed_text(&found)
            };
            let _ = std::io::stdout().write_all(text.as_bytes());
            Ok(Outcome::Ok)
        }
        SkillsCommand::Install {
            skills,
            all: _,
            agents,
            local,
            force,
            dry_run,
            json,
        } => change(
            data_dir,
            Change::Install,
            &skills,
            &agents,
            local,
            force,
            dry_run,
            json,
        ),
        SkillsCommand::Update {
            skills,
            force,
            dry_run,
            json,
        } => change(
            data_dir,
            Change::Update,
            &skills,
            &[],
            false,
            force,
            dry_run,
            json,
        ),
        SkillsCommand::Uninstall {
            skills,
            agents,
            local,
            force,
            dry_run,
            json,
        } => change(
            data_dir,
            Change::Uninstall,
            &skills,
            &agents,
            local,
            force,
            dry_run,
            json,
        ),
    }
}

/// Every skill the agents load: the agent homes, the plugin cache, the shared
/// `~/.agents/skills`, the other agents' skill folders and the worktree's `.claude/skills`.
pub fn installed(
    env: &SkillEnv,
    homes: &[xdev_kit::Home],
    worktree: Option<&Path>,
) -> Vec<xdev_kit::Skill> {
    let mut all = xdev_kit::scan_skills(homes, worktree);
    all.extend(xdev_kit::scan_agent_roots(&env.user_home));
    xdev_kit::mark_duplicates(&mut all);
    all
}

/// One line per skill: `name<TAB>scope<TAB>home<TAB>dir`. A project skill has
/// no home: `-`.
fn installed_text(found: &[xdev_kit::Skill]) -> String {
    found
        .iter()
        .map(|s| {
            let scope = match &s.scope {
                xdev_kit::SkillScope::User => "user",
                xdev_kit::SkillScope::Project => "project",
                xdev_kit::SkillScope::Plugin { .. } => "plugin",
            };
            format!(
                "{}\t{scope}\t{}\t{}\n",
                s.name,
                s.home_id.as_deref().unwrap_or("-"),
                s.dir.display()
            )
        })
        .collect()
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum Change {
    /// Writes what is missing.
    Install,
    /// Only what is already there.
    Update,
    Uninstall,
}

/// The agent ids given, or the first that is not one xDev knows.
fn check_agents(agents: &[String]) -> Result<(), String> {
    match agents.iter().find(|a| !AGENT_IDS.contains(&a.as_str())) {
        Some(a) => Err(format!(
            "no agent named {a}; choose from {}",
            AGENT_IDS.join(", ")
        )),
        None => Ok(()),
    }
}

/// The root of the repository holding `cwd`, for `--local`.
fn local_root(cwd: &Path) -> Result<PathBuf, String> {
    xdev_core::Repo::discover(cwd)
        .map(|r| r.root())
        .map_err(|_| {
            "--local needs a git repository; run it inside one or leave --local out".to_owned()
        })
}

/// Runs one change over the chosen skills and joins the reports.
fn apply(
    env: &SkillEnv,
    change: Change,
    chosen: &[&'static guide::Bundled],
    opts: InstallOpts<'_>,
) -> Result<InstallReport, xdev_orch::OrchError> {
    let mut report = InstallReport::default();
    for b in chosen {
        let r = match change {
            Change::Uninstall => skills::uninstall_one(env, b, opts)?,
            _ => skills::install_one(env, b, opts, &skills::system_link)?,
        };
        report.targets.extend(r.targets);
        report.backup = report.backup.or(r.backup);
    }
    Ok(report)
}

#[allow(clippy::too_many_arguments)]
fn change(
    data_dir: &Path,
    kind: Change,
    names: &[String],
    agents: &[String],
    local: bool,
    force: bool,
    dry_run: bool,
    json: bool,
) -> Result<Outcome, &'static str> {
    let chosen = match select(names).and_then(|c| check_agents(agents).map(|()| c)) {
        Ok(c) => c,
        Err(msg) => {
            eprintln!("error: {msg}");
            return Ok(Outcome::Exit(5));
        }
    };
    let repo = if local {
        match std::env::current_dir()
            .map_err(|e| e.to_string())
            .and_then(|d| local_root(&d))
        {
            Ok(r) => Some(r),
            Err(msg) => {
                eprintln!("error: {msg}");
                return Ok(Outcome::Exit(5));
            }
        }
    } else {
        None
    };
    let env = env_of(data_dir)?;
    let opts = InstallOpts {
        force,
        dry_run,
        present_only: kind == Change::Update,
        agents,
        local: repo.as_deref(),
        ..InstallOpts::default()
    };
    let report = apply(&env, kind, &chosen, opts).map_err(|_| "io")?;
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

    #[test]
    fn installed_text_has_four_columns() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("skills");
        std::fs::create_dir_all(root.join("x")).unwrap();
        std::fs::write(root.join("x/SKILL.md"), "---\nname: x\n---\n").unwrap();
        let found = xdev_kit::scan_skill_root(&root, "agents");
        let text = installed_text(&found);
        let cols: Vec<&str> = text.trim_end().split('\t').collect();
        assert_eq!(&cols[..3], ["x", "user", "agents"]);
        assert_eq!(cols.len(), 4);
    }

    fn temp_env(dir: &Path) -> SkillEnv {
        SkillEnv {
            user_home: dir.join("home"),
            claude_homes: vec![dir.join("home/.claude")],
            data_dir: dir.join("data"),
            now_ms: 7,
        }
    }

    fn all_skills() -> Vec<&'static guide::Bundled> {
        select(&[]).unwrap()
    }

    #[test]
    fn agent_ids_are_checked() {
        assert!(check_agents(&["claude".to_owned(), "cursor".to_owned()]).is_ok());
        let e = check_agents(&["nope".to_owned()]).unwrap_err();
        assert!(e.contains("nope") && e.contains("codex"));
    }

    #[test]
    fn the_agent_flag_limits_the_targets() {
        let dir = tempfile::tempdir().unwrap();
        let env = temp_env(dir.path());
        let only = vec!["claude".to_owned()];
        let opts = InstallOpts {
            agents: &only,
            ..InstallOpts::default()
        };
        let r = apply(&env, Change::Install, &all_skills(), opts).unwrap();
        assert_eq!(r.targets.len(), guide::BUNDLED.len());
        assert!(r.targets.iter().all(|t| t.agent == "claude"));
        assert!(!dir.path().join("home/.agents").exists());
    }

    #[test]
    fn local_needs_a_repo_and_writes_inside_it() {
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("plain");
        std::fs::create_dir_all(&outside).unwrap();
        // Inside the sandbox temp folder there is no repo above `plain`.
        let err = local_root(&outside).unwrap_err();
        assert!(err.contains("git repository"));

        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let ok = std::process::Command::new("git")
            .args(["init", "-q"])
            .arg(&repo)
            .status()
            .unwrap()
            .success();
        assert!(ok);
        let root = local_root(&repo).unwrap();
        let env = temp_env(dir.path());
        let opts = InstallOpts {
            local: Some(&root),
            ..InstallOpts::default()
        };
        let r = apply(&env, Change::Install, &all_skills(), opts).unwrap();
        assert_eq!(r.targets.len(), 2 * guide::BUNDLED.len());
        assert!(
            repo.join(".agents/skills/xdev-orchestration/SKILL.md")
                .is_file()
        );
        assert!(
            repo.join(".claude/skills/xdev-orchestration/SKILL.md")
                .is_file()
        );
        assert!(!dir.path().join("home").exists());
    }

    #[test]
    fn all_is_what_no_skill_flag_means() {
        let dir = tempfile::tempdir().unwrap();
        let env = temp_env(dir.path());
        let r = apply(&env, Change::Install, &all_skills(), InstallOpts::default()).unwrap();
        for b in &guide::BUNDLED {
            assert!(r.targets.iter().any(|t| t.skill == b.skill));
        }
    }

    #[test]
    fn uninstall_removes_what_install_wrote() {
        let dir = tempfile::tempdir().unwrap();
        let env = temp_env(dir.path());
        apply(&env, Change::Install, &all_skills(), InstallOpts::default()).unwrap();
        let one = select(&["cli".to_owned()]).unwrap();
        let r = apply(&env, Change::Uninstall, &one, InstallOpts::default()).unwrap();
        assert!(r.targets.iter().all(|t| t.skill == "xdev-cli"));
        assert!(
            r.targets
                .iter()
                .all(|t| t.action == xdev_orch::Action::Removed)
        );
        assert!(!dir.path().join("home/.agents/skills/xdev-cli").exists());
        assert!(
            dir.path()
                .join("home/.agents/skills/xdev-orchestration")
                .exists()
        );
    }
}
