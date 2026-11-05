//! The skill that teaches agents the protocol: where it is installed, how far
//! each agent can see it, and the install itself. Every path comes in through
//! [`SkillEnv`], so tests run on a temp folder and never touch the real home.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::OrchError;
use crate::guide::{BUNDLED, Bundled, SKILL_MD};

/// The orchestration skill's folder name under every skills root.
pub const SKILL_NAME: &str = "xdev-orchestration";

/// The file of the skill.
const SKILL_FILE: &str = "SKILL.md";

/// What xDev has written, so an edited copy can be told from a stale one.
const MANIFEST: &str = "orchestration-skill.json";

/// What the person can run to install the skill.
pub const INSTALL_COMMAND: &str = "xdev skills install";

/// One place the skill is written to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillTarget {
    pub agent: String,
    pub dir: PathBuf,
    /// False for the canonical copy; true for a link (or copy) of it.
    pub link: bool,
}

/// One agent CLI and whether it sees the skill.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SkillAgent {
    pub id: String,
    pub name: String,
    pub detected: bool,
    pub ready: bool,
    pub path: Option<String>,
}

/// What Settings shows on the skill card.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SkillStatus {
    pub installed: bool,
    pub edited: bool,
    pub canonical: String,
    pub agents: Vec<SkillAgent>,
    pub install_command: String,
}

/// The folders the install reads and writes.
#[derive(Debug, Clone)]
pub struct SkillEnv {
    /// The user's home: `~/.agents`, `~/.gemini`, `~/.codex`.
    pub user_home: PathBuf,
    /// Every Claude home xDev knows (default, `$CLAUDE_CONFIG_DIR`, accounts).
    pub claude_homes: Vec<PathBuf>,
    /// Where the manifest lives.
    pub data_dir: PathBuf,
    pub now_ms: i64,
}

/// What the install did to one target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Created,
    Updated,
    Unchanged,
    /// Edited by the person; left alone.
    Kept,
    /// Edited, replaced under `--force` after a backup.
    Replaced,
    /// Not touched: the canonical copy was kept.
    Skipped,
}

/// How a target holds the skill.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum How {
    Written,
    Link,
    Copy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TargetOutcome {
    /// The skill's folder name.
    pub skill: String,
    pub agent: String,
    pub dir: String,
    pub action: Action,
    pub how: How,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct InstallReport {
    pub targets: Vec<TargetOutcome>,
    /// Where replaced copies went, if any were.
    pub backup: Option<String>,
}

/// What `install` may do.
#[derive(Debug, Clone, Copy, Default)]
pub struct InstallOpts {
    /// Replace edited copies, after a backup.
    pub force: bool,
    /// Report, change nothing.
    pub dry_run: bool,
    /// Rewrite only copies that are older than the bundled one.
    pub only_outdated: bool,
    /// Touch only copies that exist: a missing one stays missing, an outdated
    /// one is updated, an edited one is kept unless `force`.
    pub present_only: bool,
}

/// Makes `dst` a link to the folder `src`.
pub type Linker<'a> = &'a dyn Fn(&Path, &Path) -> io::Result<()>;

#[derive(Debug, Clone, PartialEq, Eq)]
enum State {
    Missing,
    Current,
    Outdated,
    Edited,
}

#[derive(Serialize, Deserialize, Default)]
struct Manifest {
    /// Hash of every `SKILL.md` xDev has written.
    written: Vec<String>,
}

fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn io_err(e: io::Error) -> OrchError {
    OrchError::new("store", e.to_string())
}

/// Every place the skill `skill` goes: the canonical copy first, then a link
/// per Claude home, then Gemini when `~/.gemini` exists. Codex reads the
/// canonical root.
pub fn targets(env: &SkillEnv, skill: &str) -> Vec<SkillTarget> {
    let mut out = vec![SkillTarget {
        agent: "codex".to_owned(),
        dir: env.user_home.join(".agents").join("skills").join(skill),
        link: false,
    }];
    for home in &env.claude_homes {
        out.push(SkillTarget {
            agent: "claude".to_owned(),
            dir: home.join("skills").join(skill),
            link: true,
        });
    }
    let gemini = env.user_home.join(".gemini");
    if gemini.is_dir() {
        out.push(SkillTarget {
            agent: "gemini".to_owned(),
            dir: gemini.join("skills").join(skill),
            link: true,
        });
    }
    out
}

fn manifest(env: &SkillEnv) -> Manifest {
    fs::read(env.data_dir.join(MANIFEST))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_manifest(env: &SkillEnv, m: &Manifest) -> Result<(), OrchError> {
    fs::create_dir_all(&env.data_dir).map_err(io_err)?;
    let text = serde_json::to_vec_pretty(m).map_err(|e| OrchError::new("store", e.to_string()))?;
    fs::write(env.data_dir.join(MANIFEST), text).map_err(io_err)
}

fn inspect(dir: &Path, written: &[String], stub: &str) -> State {
    match fs::read(dir.join(SKILL_FILE)) {
        Ok(bytes) => {
            let h = hash(&bytes);
            if h == hash(stub.as_bytes()) {
                State::Current
            } else if written.contains(&h) {
                State::Outdated
            } else {
                State::Edited
            }
        }
        Err(_) => {
            // A folder with other things in it is not ours.
            let busy = fs::read_dir(dir).is_ok_and(|mut d| d.next().is_some());
            if busy { State::Edited } else { State::Missing }
        }
    }
}

/// Whether `dir` is a link (or junction) that leads to `canonical`.
fn leads_to(dir: &Path, canonical: &Path) -> bool {
    match (fs::canonicalize(dir), fs::canonicalize(canonical)) {
        (Ok(a), Ok(b)) => a == b && dir != canonical,
        _ => false,
    }
}

/// Whether `m` (from `symlink_metadata`) is a link: a symlink or, on
/// Windows, any reparse point such as a junction.
fn is_link(m: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    m.file_type().is_symlink()
}

/// Removes a link, a junction or a folder. A link loses only itself, never
/// what it leads to.
fn clear(dir: &Path) -> io::Result<()> {
    match fs::symlink_metadata(dir) {
        Err(_) => Ok(()),
        Ok(m) if is_link(&m) => fs::remove_dir(dir).or_else(|_| fs::remove_file(dir)),
        Ok(_) => fs::remove_dir_all(dir),
    }
}

fn write_copy(dir: &Path, stub: &str) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    fs::write(dir.join(SKILL_FILE), stub)
}

fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let dest = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &dest)?;
        } else {
            fs::copy(entry.path(), dest)?;
        }
    }
    Ok(())
}

/// The system's link: a symlink, and on Windows a junction when symlinks are
/// refused.
pub fn system_link(src: &Path, dst: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(src, dst)
    }
    #[cfg(windows)]
    {
        if std::os::windows::fs::symlink_dir(src, dst).is_ok() {
            return Ok(());
        }
        let out = std::process::Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(dst)
            .arg(src)
            .output()?;
        if out.status.success() {
            Ok(())
        } else {
            Err(io::Error::other("mklink /J failed"))
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (src, dst);
        Err(io::Error::other("links are not supported here"))
    }
}

fn backup_dir(env: &SkillEnv) -> PathBuf {
    env.user_home
        .join(".agents")
        .join(".xdev-skill-backups")
        .join(env.now_ms.to_string())
}

/// Installs (or, with `only_outdated`, refreshes) one skill. Edited copies
/// are kept unless `force`, which moves them to
/// `~/.agents/.xdev-skill-backups/<ms>/` first.
pub fn install_one(
    env: &SkillEnv,
    b: &Bundled,
    opts: InstallOpts,
    link: Linker<'_>,
) -> Result<InstallReport, OrchError> {
    let mut m = manifest(env);
    let canonical = env.user_home.join(".agents").join("skills").join(b.skill);
    let mut report = InstallReport::default();
    let mut canonical_kept = false;

    for t in targets(env, b.skill) {
        let state = inspect(&t.dir, &m.written, b.stub);
        let outcome = |action, how| TargetOutcome {
            skill: b.skill.to_owned(),
            agent: t.agent.clone(),
            dir: t.dir.display().to_string(),
            action,
            how,
        };
        let how_now = if !t.link {
            How::Written
        } else if leads_to(&t.dir, &canonical) {
            How::Link
        } else {
            How::Copy
        };
        if canonical_kept && t.link {
            report.targets.push(outcome(Action::Skipped, how_now));
            continue;
        }
        let (action, replace) = match state {
            State::Current => (Action::Unchanged, false),
            State::Missing if opts.present_only => (Action::Unchanged, false),
            _ if opts.only_outdated && state != State::Outdated => (Action::Unchanged, false),
            State::Missing => (Action::Created, true),
            State::Outdated => (Action::Updated, true),
            State::Edited if opts.force => (Action::Replaced, true),
            State::Edited => (Action::Kept, false),
        };
        if action == Action::Kept && !t.link {
            canonical_kept = true;
        }
        if !replace || opts.dry_run {
            let how = if replace && t.link {
                How::Link
            } else {
                how_now
            };
            report.targets.push(outcome(action, how));
            continue;
        }
        if action == Action::Replaced {
            let backup = backup_dir(env);
            let leads = leads_to(&t.dir, &canonical);
            if !leads && t.dir.exists() {
                let to = backup.join(format!("{}-{}-{}", b.skill, t.agent, report.targets.len()));
                copy_tree(&t.dir, &to).map_err(io_err)?;
                report.backup = Some(backup.display().to_string());
            }
        }
        clear(&t.dir).map_err(io_err)?;
        let how = if t.link {
            if let Some(parent) = t.dir.parent() {
                fs::create_dir_all(parent).map_err(io_err)?;
            }
            if link(&canonical, &t.dir).is_ok() {
                How::Link
            } else {
                // Links refused: a plain copy keeps the agent working.
                let _ = clear(&t.dir);
                write_copy(&t.dir, b.stub).map_err(io_err)?;
                How::Copy
            }
        } else {
            write_copy(&t.dir, b.stub).map_err(io_err)?;
            How::Written
        };
        report.targets.push(outcome(action, how));
    }

    if !opts.dry_run {
        let h = hash(b.stub.as_bytes());
        if !m.written.contains(&h) {
            m.written.push(h);
        }
        save_manifest(env, &m)?;
    }
    Ok(report)
}

/// Installs every bundled skill, in `BUNDLED` order; the reports are
/// concatenated.
pub fn install(
    env: &SkillEnv,
    opts: InstallOpts,
    link: Linker<'_>,
) -> Result<InstallReport, OrchError> {
    let mut all = InstallReport::default();
    for b in &BUNDLED {
        let r = install_one(env, b, opts, link)?;
        all.targets.extend(r.targets);
        all.backup = all.backup.or(r.backup);
    }
    Ok(all)
}

/// What Settings shows: installed, edited, and which agents see the skill.
pub fn status(env: &SkillEnv) -> Result<SkillStatus, OrchError> {
    let m = manifest(env);
    let all = targets(env, SKILL_NAME);
    let canonical = all[0].dir.clone();
    let has = |dir: &Path| dir.join(SKILL_FILE).is_file();
    let edited = all
        .iter()
        .any(|t| has(&t.dir) && inspect(&t.dir, &m.written, SKILL_MD) == State::Edited);
    let claude: Vec<&SkillTarget> = all.iter().filter(|t| t.agent == "claude").collect();
    let gemini = all.iter().find(|t| t.agent == "gemini");
    let agent =
        |id: &str, name: &str, detected: bool, ready: bool, path: Option<&Path>| SkillAgent {
            id: id.to_owned(),
            name: name.to_owned(),
            detected,
            ready,
            path: path.map(|p| p.display().to_string()),
        };
    let agents = vec![
        agent(
            "claude",
            "Claude",
            !claude.is_empty(),
            !claude.is_empty() && claude.iter().all(|t| has(&t.dir)),
            claude.first().map(|t| t.dir.as_path()),
        ),
        agent(
            "codex",
            "Codex",
            env.user_home.join(".codex").is_dir(),
            has(&canonical),
            Some(&canonical),
        ),
        agent(
            "gemini",
            "Gemini",
            gemini.is_some(),
            gemini.is_some_and(|t| has(&t.dir)),
            gemini.map(|t| t.dir.as_path()),
        ),
    ];
    Ok(SkillStatus {
        installed: has(&canonical),
        edited,
        canonical: canonical.display().to_string(),
        agents,
        install_command: INSTALL_COMMAND.to_owned(),
    })
}

/// App start: for each bundled skill that has been installed once, rewrites
/// the copies that are older than the bundled one and that nobody edited.
pub fn auto_update(env: &SkillEnv, link: Linker<'_>) -> Result<InstallReport, OrchError> {
    let mut all = InstallReport::default();
    for b in &BUNDLED {
        if !targets(env, b.skill)[0].dir.join(SKILL_FILE).is_file() {
            continue;
        }
        let r = install_one(
            env,
            b,
            InstallOpts {
                only_outdated: true,
                ..InstallOpts::default()
            },
            link,
        )?;
        all.targets.extend(r.targets);
        all.backup = all.backup.or(r.backup);
    }
    Ok(all)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn clearing_a_junction_keeps_what_it_leads_to() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("shared");
        fs::create_dir_all(target.join("deep")).unwrap();
        fs::write(target.join(SKILL_FILE), "keep").unwrap();
        fs::write(target.join("deep").join("x.txt"), "keep").unwrap();
        let link = dir.path().join("link");
        let ok = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&target)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "mklink /J");
        let m = fs::symlink_metadata(&link).unwrap();
        assert!(is_link(&m), "a junction counts as a link");
        // Even when `remove_dir` cannot take it, the contents stay.
        clear(&link).unwrap();
        assert!(fs::symlink_metadata(&link).is_err(), "the link is gone");
        assert_eq!(fs::read_to_string(target.join(SKILL_FILE)).unwrap(), "keep");
        assert!(target.join("deep").join("x.txt").is_file());
    }

    struct Home {
        _dir: tempfile::TempDir,
        env: SkillEnv,
    }

    fn home(claude: usize, gemini: bool) -> Home {
        let dir = tempfile::tempdir().unwrap();
        let user = dir.path().join("user");
        let mut claude_homes = Vec::new();
        for i in 0..claude {
            let h = user.join(format!(".claude{i}"));
            fs::create_dir_all(&h).unwrap();
            claude_homes.push(h);
        }
        if gemini {
            fs::create_dir_all(user.join(".gemini")).unwrap();
        }
        let env = SkillEnv {
            user_home: user,
            claude_homes,
            data_dir: dir.path().join("data"),
            now_ms: 1_000,
        };
        Home { _dir: dir, env }
    }

    fn orch() -> &'static Bundled {
        crate::guide::find("orchestration").unwrap()
    }

    fn cli() -> &'static Bundled {
        crate::guide::find("cli").unwrap()
    }

    fn copy_linker(_: &Path, _: &Path) -> io::Result<()> {
        Err(io::Error::other("refused"))
    }

    fn links(src: &Path, dst: &Path) -> io::Result<()> {
        system_link(src, dst)
    }

    fn canonical(h: &Home) -> PathBuf {
        h.env.user_home.join(".agents/skills").join(SKILL_NAME)
    }

    fn read(dir: &Path) -> String {
        fs::read_to_string(dir.join(SKILL_FILE)).unwrap()
    }

    #[test]
    fn a_fresh_install_writes_the_canonical_copy_and_reaches_every_agent() {
        let h = home(2, true);
        let r = install_one(&h.env, orch(), InstallOpts::default(), &copy_linker).unwrap();
        // Codex + two Claude homes + Gemini.
        assert_eq!(r.targets.len(), 4);
        assert!(r.targets.iter().all(|t| t.action == Action::Created));
        assert_eq!(read(&canonical(&h)), SKILL_MD);
        for t in targets(&h.env, SKILL_NAME) {
            assert_eq!(read(&t.dir), SKILL_MD, "{}", t.dir.display());
        }
        let s = status(&h.env).unwrap();
        assert!(s.installed && !s.edited);
        assert_eq!(s.install_command, "xdev skills install");
        assert!(
            s.agents
                .iter()
                .all(|a| a.detected && a.ready || a.id == "codex")
        );
        assert!(s.agents.iter().find(|a| a.id == "codex").unwrap().ready);
    }

    #[test]
    fn installing_again_changes_nothing() {
        let h = home(1, true);
        install_one(&h.env, orch(), InstallOpts::default(), &copy_linker).unwrap();
        let r = install_one(&h.env, orch(), InstallOpts::default(), &copy_linker).unwrap();
        assert!(r.targets.iter().all(|t| t.action == Action::Unchanged));
        assert_eq!(r.backup, None);
    }

    #[test]
    fn a_dry_run_reports_and_writes_nothing() {
        let h = home(1, false);
        let r = install_one(
            &h.env,
            orch(),
            InstallOpts {
                dry_run: true,
                ..InstallOpts::default()
            },
            &copy_linker,
        )
        .unwrap();
        assert!(r.targets.iter().all(|t| t.action == Action::Created));
        assert!(!canonical(&h).exists());
        assert!(!h.env.data_dir.join(MANIFEST).exists());
    }

    #[test]
    fn an_edited_copy_is_kept_and_force_replaces_it_after_a_backup() {
        let h = home(1, false);
        install_one(&h.env, orch(), InstallOpts::default(), &copy_linker).unwrap();
        let claude = targets(&h.env, SKILL_NAME)[1].dir.clone();
        fs::write(claude.join(SKILL_FILE), "my own notes").unwrap();
        assert!(status(&h.env).unwrap().edited);

        let r = install_one(&h.env, orch(), InstallOpts::default(), &copy_linker).unwrap();
        let t = r.targets.iter().find(|t| t.agent == "claude").unwrap();
        assert_eq!(t.action, Action::Kept);
        assert_eq!(read(&claude), "my own notes");

        let r = install_one(
            &h.env,
            orch(),
            InstallOpts {
                force: true,
                ..InstallOpts::default()
            },
            &copy_linker,
        )
        .unwrap();
        let t = r.targets.iter().find(|t| t.agent == "claude").unwrap();
        assert_eq!(t.action, Action::Replaced);
        assert_eq!(read(&claude), SKILL_MD);
        let backup = PathBuf::from(r.backup.unwrap());
        assert!(backup.starts_with(h.env.user_home.join(".agents/.xdev-skill-backups")));
        let saved: Vec<_> = fs::read_dir(&backup).unwrap().collect();
        assert_eq!(saved.len(), 1);
        let saved = saved[0].as_ref().unwrap().path();
        assert_eq!(read(&saved), "my own notes");
        assert!(!status(&h.env).unwrap().edited);
    }

    #[test]
    fn an_edited_canonical_copy_holds_the_links_back() {
        let h = home(1, false);
        let c = canonical(&h);
        fs::create_dir_all(&c).unwrap();
        fs::write(c.join(SKILL_FILE), "somebody else's skill").unwrap();
        let r = install_one(&h.env, orch(), InstallOpts::default(), &copy_linker).unwrap();
        assert_eq!(r.targets[0].action, Action::Kept);
        assert_eq!(r.targets[1].action, Action::Skipped);
        assert_eq!(read(&c), "somebody else's skill");
        assert!(!targets(&h.env, SKILL_NAME)[1].dir.exists());
    }

    #[test]
    fn links_are_used_when_the_system_allows_them() {
        let h = home(1, false);
        let r = install_one(&h.env, orch(), InstallOpts::default(), &links).unwrap();
        let t = r.targets.iter().find(|t| t.agent == "claude").unwrap();
        // Windows without Developer Mode may refuse both kinds of link; a
        // copy is then the right answer.
        assert!(matches!(t.how, How::Link | How::Copy));
        if t.how == How::Link {
            assert!(leads_to(
                &targets(&h.env, SKILL_NAME)[1].dir,
                &canonical(&h)
            ));
        }
        assert_eq!(read(&targets(&h.env, SKILL_NAME)[1].dir), SKILL_MD);
    }

    #[test]
    fn refused_links_fall_back_to_a_copy() {
        let h = home(1, true);
        let r = install_one(&h.env, orch(), InstallOpts::default(), &copy_linker).unwrap();
        for t in r.targets.iter().filter(|t| t.agent != "codex") {
            assert_eq!(t.how, How::Copy);
        }
    }

    #[test]
    fn an_unedited_stale_copy_is_refreshed_by_the_auto_update() {
        let h = home(1, false);
        // What an older xDev wrote, recorded in the manifest.
        let old = "old skill text";
        for t in targets(&h.env, SKILL_NAME) {
            fs::create_dir_all(&t.dir).unwrap();
            fs::write(t.dir.join(SKILL_FILE), old).unwrap();
        }
        save_manifest(
            &h.env,
            &Manifest {
                written: vec![hash(old.as_bytes())],
            },
        )
        .unwrap();
        let r = auto_update(&h.env, &copy_linker).unwrap();
        assert!(r.targets.iter().all(|t| t.action == Action::Updated));
        assert_eq!(read(&canonical(&h)), SKILL_MD);
        // And an edited one is left alone.
        let claude = targets(&h.env, SKILL_NAME)[1].dir.clone();
        fs::write(claude.join(SKILL_FILE), "mine").unwrap();
        let r = auto_update(&h.env, &copy_linker).unwrap();
        assert!(r.targets.iter().all(|t| t.action == Action::Unchanged));
        assert_eq!(read(&claude), "mine");
    }

    #[test]
    fn the_auto_update_does_nothing_before_the_first_install() {
        let h = home(1, true);
        let r = auto_update(&h.env, &copy_linker).unwrap();
        assert!(r.targets.is_empty());
        assert!(!canonical(&h).exists());
    }

    #[test]
    fn coverage_counts_what_each_agent_sees() {
        let h = home(2, true);
        let s = status(&h.env).unwrap();
        assert!(!s.installed);
        assert!(s.agents.iter().all(|a| !a.ready));
        install_one(&h.env, orch(), InstallOpts::default(), &copy_linker).unwrap();
        // One Claude home loses it: Claude is no longer ready as a whole.
        fs::remove_dir_all(targets(&h.env, SKILL_NAME)[1].dir.clone()).unwrap();
        let s = status(&h.env).unwrap();
        let claude = s.agents.iter().find(|a| a.id == "claude").unwrap();
        assert!(claude.detected && !claude.ready);
        assert!(s.agents.iter().find(|a| a.id == "gemini").unwrap().ready);
        assert!(s.agents.iter().find(|a| a.id == "codex").unwrap().ready);
        // No Gemini folder: not detected, not a target.
        let none = home(0, false);
        let s = status(&none.env).unwrap();
        assert!(s.agents.iter().all(|a| !a.detected));
    }

    #[test]
    fn a_fresh_install_writes_every_bundled_skill() {
        let h = home(1, false);
        let r = install(&h.env, InstallOpts::default(), &copy_linker).unwrap();
        // Codex + one Claude home, per skill.
        assert_eq!(r.targets.len(), 2 * BUNDLED.len());
        for b in &BUNDLED {
            let n = r.targets.iter().filter(|t| t.skill == b.skill).count();
            assert_eq!(n, 2, "{}", b.skill);
            for t in targets(&h.env, b.skill) {
                assert_eq!(read(&t.dir), b.stub, "{}", t.dir.display());
            }
        }
        assert!(r.targets.iter().all(|t| t.action == Action::Created));
    }

    #[test]
    fn install_one_touches_only_its_skill() {
        let h = home(1, false);
        let r = install_one(&h.env, cli(), InstallOpts::default(), &copy_linker).unwrap();
        assert!(r.targets.iter().all(|t| t.skill == "xdev-cli"));
        assert!(
            targets(&h.env, "xdev-cli")[0]
                .dir
                .join(SKILL_FILE)
                .is_file()
        );
        assert!(!canonical(&h).exists());
    }

    #[test]
    fn an_edited_cli_copy_is_kept_and_orchestration_is_still_updated() {
        let h = home(1, false);
        install(&h.env, InstallOpts::default(), &copy_linker).unwrap();
        // Orchestration goes stale; the cli copy is edited.
        let old = "old skill text";
        save_manifest(
            &h.env,
            &Manifest {
                written: vec![
                    hash(old.as_bytes()),
                    hash(SKILL_MD.as_bytes()),
                    hash(cli().stub.as_bytes()),
                ],
            },
        )
        .unwrap();
        for t in targets(&h.env, SKILL_NAME) {
            fs::write(t.dir.join(SKILL_FILE), old).unwrap();
        }
        let cli_claude = targets(&h.env, "xdev-cli")[1].dir.clone();
        fs::write(cli_claude.join(SKILL_FILE), "mine").unwrap();
        let r = auto_update(&h.env, &copy_linker).unwrap();
        let of = |skill: &str, agent: &str| {
            r.targets
                .iter()
                .find(|t| t.skill == skill && t.agent == agent)
                .unwrap()
                .action
        };
        assert_eq!(of(SKILL_NAME, "codex"), Action::Updated);
        assert_eq!(of(SKILL_NAME, "claude"), Action::Updated);
        assert_eq!(of("xdev-cli", "claude"), Action::Unchanged);
        assert_eq!(read(&cli_claude), "mine");
        assert_eq!(read(&canonical(&h)), SKILL_MD);
    }

    fn present_only() -> InstallOpts {
        InstallOpts {
            present_only: true,
            ..InstallOpts::default()
        }
    }

    fn stale(h: &Home, b: &Bundled) {
        let old = "old skill text";
        for t in targets(&h.env, b.skill) {
            fs::create_dir_all(&t.dir).unwrap();
            fs::write(t.dir.join(SKILL_FILE), old).unwrap();
        }
        let mut m = manifest(&h.env);
        m.written.push(hash(old.as_bytes()));
        save_manifest(&h.env, &m).unwrap();
    }

    #[test]
    fn present_only_never_creates_a_missing_copy() {
        let h = home(1, false);
        let r = install_one(&h.env, orch(), present_only(), &copy_linker).unwrap();
        assert!(r.targets.iter().all(|t| t.action == Action::Unchanged));
        assert!(!canonical(&h).exists());
        // A copy missing in one home stays missing while the others update.
        stale(&h, orch());
        fs::remove_dir_all(targets(&h.env, SKILL_NAME)[1].dir.clone()).unwrap();
        let r = install_one(&h.env, orch(), present_only(), &copy_linker).unwrap();
        assert_eq!(r.targets[0].action, Action::Updated);
        assert_eq!(r.targets[1].action, Action::Unchanged);
        assert!(!targets(&h.env, SKILL_NAME)[1].dir.exists());
    }

    #[test]
    fn present_only_updates_an_outdated_copy() {
        let h = home(1, false);
        stale(&h, orch());
        let r = install_one(&h.env, orch(), present_only(), &copy_linker).unwrap();
        assert!(r.targets.iter().all(|t| t.action == Action::Updated));
        assert_eq!(read(&canonical(&h)), SKILL_MD);
    }

    #[test]
    fn present_only_replaces_an_edited_copy_only_with_force() {
        let h = home(1, false);
        install_one(&h.env, orch(), InstallOpts::default(), &copy_linker).unwrap();
        let claude = targets(&h.env, SKILL_NAME)[1].dir.clone();
        fs::write(claude.join(SKILL_FILE), "mine").unwrap();
        let r = install_one(&h.env, orch(), present_only(), &copy_linker).unwrap();
        assert_eq!(r.targets[1].action, Action::Kept);
        assert_eq!(read(&claude), "mine");
        let forced = InstallOpts {
            force: true,
            ..present_only()
        };
        let r = install_one(&h.env, orch(), forced, &copy_linker).unwrap();
        assert_eq!(r.targets[1].action, Action::Replaced);
        assert!(r.backup.is_some());
        assert_eq!(read(&claude), SKILL_MD);
    }

    #[test]
    fn auto_update_refreshes_each_installed_skill_and_skips_the_rest() {
        let h = home(1, false);
        stale(&h, orch());
        let r = auto_update(&h.env, &copy_linker).unwrap();
        assert!(r.targets.iter().all(|t| t.skill == SKILL_NAME));
        assert!(r.targets.iter().all(|t| t.action == Action::Updated));
        assert!(!targets(&h.env, "xdev-cli")[0].dir.exists());
        // Both installed: both are refreshed.
        stale(&h, cli());
        let r = auto_update(&h.env, &copy_linker).unwrap();
        assert!(
            r.targets
                .iter()
                .any(|t| t.skill == "xdev-cli" && t.action == Action::Updated)
        );
    }
}
