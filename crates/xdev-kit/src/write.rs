//! The only module that writes. Every path is checked against the known
//! homes and the worktree first, and a save is refused when the file changed
//! since it was read.

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::{KitError, fnv1a_hex};

const TMP_SUFFIX: &str = ".xdev-tmp";
const SKILL_FILE: &str = "SKILL.md";

/// The folders a write may reach, and where removed skills go.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Roots {
    pub homes: Vec<PathBuf>,
    pub worktree: Option<PathBuf>,
    pub data_dir: PathBuf,
}

impl Roots {
    fn canonical(&self) -> Vec<PathBuf> {
        self.homes
            .iter()
            .chain(self.worktree.iter())
            .filter_map(|r| r.canonicalize().ok())
            .collect()
    }

    /// Where `path` is, or would be: its parent made canonical, plus its
    /// name. `Outside` unless that parent is under a root. A relative path,
    /// or one with a `..` part, is `Outside`.
    fn resolve(&self, path: &Path) -> Result<PathBuf, KitError> {
        let outside = || KitError::Outside(path.to_path_buf());
        if !path.is_absolute() || path.components().any(|c| c == Component::ParentDir) {
            return Err(outside());
        }
        let name = path.file_name().ok_or_else(outside)?;
        let parent = canonical_prefix(path.parent().ok_or_else(outside)?)?;
        if !self.canonical().iter().any(|root| parent.starts_with(root)) {
            return Err(outside());
        }
        Ok(parent.join(name))
    }

    fn removed_dir(&self) -> PathBuf {
        self.data_dir.join("kit").join("removed")
    }
}

/// The canonical form of the deepest folder that exists, with the part that
/// does not exist yet put back on.
fn canonical_prefix(path: &Path) -> Result<PathBuf, KitError> {
    let mut current = path.to_path_buf();
    let mut tail = Vec::new();
    loop {
        if let Ok(mut canon) = current.canonicalize() {
            canon.extend(tail.iter().rev());
            return Ok(canon);
        }
        let Some(name) = current.file_name().map(|n| n.to_owned()) else {
            return Err(KitError::Outside(path.to_path_buf()));
        };
        tail.push(name);
        current.pop();
    }
}

/// `"<len>:<mtime-ns>:<fnv>"`.
fn stamp_of(meta: &fs::Metadata, bytes: &[u8]) -> String {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    format!("{}:{mtime}:{}", bytes.len(), fnv1a_hex(bytes))
}

/// The bytes and the stamp of a file, read through one handle.
fn read_stamped(path: &Path) -> io::Result<(Vec<u8>, String)> {
    let mut file = File::open(path)?;
    let meta = file.metadata()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let stamp = stamp_of(&meta, &bytes);
    Ok((bytes, stamp))
}

/// The text of a file under the roots, and the stamp to give back to `write_checked`.
pub fn read_for_edit(roots: &Roots, path: &Path) -> Result<(String, String), KitError> {
    let path = roots.resolve(path)?;
    let (bytes, stamp) = read_stamped(&path)?;
    let text = String::from_utf8(bytes).map_err(|_| KitError::Parse("not UTF-8 text".into()))?;
    Ok((text, stamp))
}

/// Saves `text` and returns the new stamp. `stamp` is what `read_for_edit`
/// gave; `None` means the file must not exist yet. A file that is not as it
/// was read is `Changed` and keeps its bytes.
pub fn write_checked(
    roots: &Roots,
    path: &Path,
    text: &str,
    stamp: Option<&str>,
) -> Result<String, KitError> {
    let path = roots.resolve(path)?;
    check_unchanged(&path, stamp)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = sibling_tmp(&path);
    let result = (|| {
        let mut file = File::create(&tmp)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        drop(file);
        // Again, as late as possible: the temp file took time to write.
        check_unchanged(&path, stamp)?;
        replace(&tmp, &path)?;
        Ok::<(), KitError>(())
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    let (_, fresh) = read_stamped(&path)?;
    Ok(fresh)
}

fn check_unchanged(path: &Path, stamp: Option<&str>) -> Result<(), KitError> {
    match (stamp, read_stamped(path)) {
        (None, Err(e)) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        (None, _) => Err(KitError::Changed),
        (Some(_), Err(e)) if e.kind() == io::ErrorKind::NotFound => Err(KitError::Changed),
        (Some(_), Err(e)) => Err(e.into()),
        (Some(old), Ok((_, now))) if old == now => Ok(()),
        (Some(_), Ok(_)) => Err(KitError::Changed),
    }
}

fn sibling_tmp(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(TMP_SUFFIX);
    PathBuf::from(name)
}

/// Renames `tmp` over `target`. Windows renames over an existing file; when
/// a platform will not, the target is removed and the rename tried again.
fn replace(tmp: &Path, target: &Path) -> io::Result<()> {
    match fs::rename(tmp, target) {
        Err(_) if cfg!(windows) && target.is_file() => {
            fs::remove_file(target)?;
            fs::rename(tmp, target)
        }
        other => other,
    }
}

/// Copies one file. An existing target is `Changed`.
pub fn copy_file(roots: &Roots, from: &Path, to: &Path) -> Result<(), KitError> {
    let from = roots.resolve(from)?;
    let to = roots.resolve(to)?;
    if to.symlink_metadata().is_ok() {
        return Err(KitError::Changed);
    }
    if let Some(dir) = to.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = sibling_tmp(&to);
    let result = (|| {
        fs::copy(&from, &tmp)?;
        if to.symlink_metadata().is_ok() {
            return Err(KitError::Changed);
        }
        fs::rename(&tmp, &to)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Copies a skill folder into `to_skills_dir`, under its own name, and
/// returns the new folder. Links inside it are left out, so a link cannot
/// carry a file from outside the roots in.
pub fn copy_skill_dir(
    roots: &Roots,
    from: &Path,
    to_skills_dir: &Path,
) -> Result<PathBuf, KitError> {
    let from = roots.resolve(from)?;
    require_skill_dir(&from)?;
    let name = from
        .file_name()
        .ok_or_else(|| KitError::Outside(from.clone()))?;
    let dest = roots.resolve(&to_skills_dir.join(name))?;
    if dest.starts_with(&from) {
        return Err(KitError::Io("a skill cannot be copied into itself".into()));
    }
    if dest.symlink_metadata().is_ok() {
        return Err(KitError::Changed);
    }
    if let Some(dir) = dest.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = sibling_tmp(&dest);
    let result = (|| {
        copy_tree(&from, &tmp, true)?;
        if dest.symlink_metadata().is_ok() {
            return Err(KitError::Changed);
        }
        fs::rename(&tmp, &dest)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&tmp);
    }
    result.map(|()| to_skills_dir.join(name))
}

/// Moves a skill folder to `<data dir>/kit/removed/<unix-ms>/<name>/` and
/// returns that folder. Nothing is deleted.
pub fn remove_skill(roots: &Roots, dir: &Path) -> Result<PathBuf, KitError> {
    let dir = roots.resolve(dir)?;
    require_skill_dir(&dir)?;
    let name = dir
        .file_name()
        .ok_or_else(|| KitError::Outside(dir.clone()))?;
    let base = roots.removed_dir();
    let mut ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    while base.join(ms.to_string()).join(name).exists() {
        ms += 1;
    }
    let target = base.join(ms.to_string()).join(name);
    move_dir(&dir, &target)?;
    Ok(target)
}

/// Moves a folder that `remove_skill` made back to `to`. An existing target is `Changed`.
pub fn restore_skill(roots: &Roots, removed: &Path, to: &Path) -> Result<(), KitError> {
    let removed_canon = canonical_prefix(removed)?;
    let area = canonical_prefix(&roots.removed_dir())?;
    if !removed.is_absolute()
        || removed.components().any(|c| c == Component::ParentDir)
        || !removed_canon.starts_with(&area)
        || removed_canon == area
    {
        return Err(KitError::Outside(removed.to_path_buf()));
    }
    require_skill_dir(&removed_canon)?;
    let to = roots.resolve(to)?;
    if to.symlink_metadata().is_ok() {
        return Err(KitError::Changed);
    }
    move_dir(&removed_canon, &to)
}

/// Writes `<skills_dir>/<name>/SKILL.md` from the template and returns that file.
pub fn new_skill(
    roots: &Roots,
    skills_dir: &Path,
    name: &str,
    description: &str,
) -> Result<PathBuf, KitError> {
    // The same rule as account names (`xdev_ai::valid_name`): the name is a
    // folder name, so nothing that could leave `skills/` gets through.
    if !xdev_ai::valid_name(name) {
        return Err(KitError::Parse("bad skill name".into()));
    }
    if description.contains(['\n', '\r']) {
        return Err(KitError::Parse("the description is one line".into()));
    }
    let file = skills_dir.join(name).join(SKILL_FILE);
    let text = format!(
        "---\nname: {name}\ndescription: {}\n---\n\n# {name}\n\n## When to use\n\n## Steps\n",
        description.trim()
    );
    write_checked(roots, &file, &text, None)?;
    Ok(file)
}

fn require_skill_dir(dir: &Path) -> Result<(), KitError> {
    if dir.join(SKILL_FILE).is_file() {
        Ok(())
    } else {
        Err(KitError::Parse("not a skill folder".into()))
    }
}

/// A rename, or a copy and removal of the original when the two places are
/// on different drives. The copy is whole before anything is removed.
fn move_dir(from: &Path, to: &Path) -> Result<(), KitError> {
    if let Some(dir) = to.parent() {
        fs::create_dir_all(dir)?;
    }
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    if let Err(e) = copy_tree(from, to, false) {
        let _ = fs::remove_dir_all(to);
        return Err(e);
    }
    fs::remove_dir_all(from)?;
    Ok(())
}

/// Copies a folder. A link is skipped when `skip_links`, and an error
/// otherwise.
fn copy_tree(from: &Path, to: &Path, skip_links: bool) -> Result<(), KitError> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = to.join(entry.file_name());
        if kind.is_symlink() {
            if skip_links {
                continue;
            }
            return Err(KitError::Io(format!(
                "{} is a link",
                entry.path().display()
            )));
        }
        if kind.is_dir() {
            copy_tree(&entry.path(), &target, skip_links)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct Fixture {
        _tmp: tempfile::TempDir,
        home: PathBuf,
        roots: Roots,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let roots = Roots {
            homes: vec![home.clone()],
            worktree: None,
            data_dir: tmp.path().join("data"),
        };
        Fixture {
            _tmp: tmp,
            home,
            roots,
        }
    }

    #[test]
    fn write_round_trip_returns_new_stamp() {
        let fx = fixture();
        let file = fx.home.join("CLAUDE.md");
        fs::write(&file, "one").unwrap();
        let (text, stamp) = read_for_edit(&fx.roots, &file).unwrap();
        assert_eq!(text, "one");
        assert!(stamp.starts_with("3:"), "{stamp}");
        let fresh = write_checked(&fx.roots, &file, "two!", Some(&stamp)).unwrap();
        assert_ne!(fresh, stamp);
        assert_eq!(fs::read_to_string(&file).unwrap(), "two!");
        // The stamp that came back is the one a new read gives.
        let (_, again) = read_for_edit(&fx.roots, &file).unwrap();
        assert_eq!(fresh, again);
        // And it lets the next save through.
        write_checked(&fx.roots, &file, "three", Some(&fresh)).unwrap();
        assert!(!fx.home.join("CLAUDE.md.xdev-tmp").exists());
    }

    #[test]
    fn write_refuses_when_file_changed() {
        let fx = fixture();
        let file = fx.home.join("CLAUDE.md");
        fs::write(&file, "mine").unwrap();
        let (_, stamp) = read_for_edit(&fx.roots, &file).unwrap();
        // The agent edits the file while it is open here.
        fs::write(&file, "agent bytes").unwrap();
        let err = write_checked(&fx.roots, &file, "stale save", Some(&stamp)).unwrap_err();
        assert_eq!(err, KitError::Changed);
        assert_eq!(fs::read_to_string(&file).unwrap(), "agent bytes");
        assert!(!fx.home.join("CLAUDE.md.xdev-tmp").exists());
    }

    #[test]
    fn write_refuses_same_length_change() {
        let fx = fixture();
        let file = fx.home.join("a.md");
        fs::write(&file, "aaaa").unwrap();
        let (_, stamp) = read_for_edit(&fx.roots, &file).unwrap();
        // Same length; the hash part of the stamp still tells them apart.
        let (len, rest) = stamp.split_once(':').unwrap();
        let (mtime, _) = rest.split_once(':').unwrap();
        let forged = format!("{len}:{mtime}:0000000000000000");
        assert_eq!(
            write_checked(&fx.roots, &file, "x", Some(&forged)),
            Err(KitError::Changed)
        );
    }

    #[test]
    fn write_outside_roots_refused() {
        let fx = fixture();
        let elsewhere = tempfile::tempdir().unwrap();
        let target = elsewhere.path().join("x.md");

        let dotdot = fx.home.join("sub").join("..").join("..").join("x.md");
        fs::create_dir_all(fx.home.join("sub")).unwrap();
        assert!(matches!(
            write_checked(&fx.roots, &dotdot, "no", None),
            Err(KitError::Outside(_))
        ));
        assert!(matches!(
            write_checked(&fx.roots, &target, "no", None),
            Err(KitError::Outside(_))
        ));
        assert!(!target.exists());
        assert!(matches!(
            read_for_edit(&fx.roots, &target),
            Err(KitError::Outside(_))
        ));
        assert!(matches!(
            write_checked(&fx.roots, Path::new("relative.md"), "no", None),
            Err(KitError::Outside(_))
        ));
    }

    #[test]
    fn new_file_requires_none_stamp() {
        let fx = fixture();
        let file = fx.home.join("deep").join("new.md");
        // A stamp for a file that is not there: it was removed since the read.
        assert_eq!(
            write_checked(&fx.roots, &file, "x", Some("1:2:3")),
            Err(KitError::Changed)
        );
        let stamp = write_checked(&fx.roots, &file, "x", None).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "x");
        // `None` means the file must not exist yet.
        assert_eq!(
            write_checked(&fx.roots, &file, "y", None),
            Err(KitError::Changed)
        );
        assert_eq!(fs::read_to_string(&file).unwrap(), "x");
        write_checked(&fx.roots, &file, "y", Some(&stamp)).unwrap();
    }

    #[test]
    fn remove_then_restore_skill() {
        let fx = fixture();
        let skill = fx.home.join("skills").join("demo");
        fs::create_dir_all(skill.join("scripts")).unwrap();
        fs::write(skill.join("SKILL.md"), "skill").unwrap();
        fs::write(skill.join("scripts").join("run.sh"), "run").unwrap();

        let removed = remove_skill(&fx.roots, &skill).unwrap();
        assert!(!skill.exists());
        assert!(removed.join("SKILL.md").is_file());
        assert_eq!(removed.file_name().unwrap(), "demo");
        let kit_removed = fx.roots.data_dir.join("kit").join("removed");
        assert!(removed.starts_with(&kit_removed));
        // `<unix-ms>/<name>`.
        let stamp = removed.parent().unwrap().file_name().unwrap();
        assert!(stamp.to_string_lossy().parse::<u128>().is_ok());

        // Only something that was removed can be restored.
        let stray = fx.home.join("stray");
        fs::create_dir_all(&stray).unwrap();
        assert!(matches!(
            restore_skill(&fx.roots, &stray, &fx.home.join("skills").join("stray2")),
            Err(KitError::Outside(_))
        ));

        restore_skill(&fx.roots, &removed, &skill).unwrap();
        assert_eq!(fs::read_to_string(skill.join("SKILL.md")).unwrap(), "skill");
        assert_eq!(
            fs::read_to_string(skill.join("scripts").join("run.sh")).unwrap(),
            "run"
        );
        assert!(!removed.exists());

        // A folder that is not a skill is not removed.
        assert!(matches!(
            remove_skill(&fx.roots, &fx.home.join("skills")),
            Err(KitError::Parse(_))
        ));
    }

    #[test]
    fn restore_refuses_existing_target() {
        let fx = fixture();
        let skill = fx.home.join("skills").join("demo");
        fs::create_dir_all(&skill).unwrap();
        fs::write(skill.join("SKILL.md"), "old").unwrap();
        let removed = remove_skill(&fx.roots, &skill).unwrap();
        fs::create_dir_all(&skill).unwrap();
        fs::write(skill.join("SKILL.md"), "newer").unwrap();
        assert_eq!(
            restore_skill(&fx.roots, &removed, &skill),
            Err(KitError::Changed)
        );
        assert_eq!(fs::read_to_string(skill.join("SKILL.md")).unwrap(), "newer");
        assert!(removed.join("SKILL.md").is_file());
    }

    #[test]
    fn copy_refuses_existing_target() {
        let fx = fixture();
        let from = fx.home.join("a.md");
        let to = fx.home.join("b.md");
        fs::write(&from, "a").unwrap();
        copy_file(&fx.roots, &from, &to).unwrap();
        assert_eq!(fs::read_to_string(&to).unwrap(), "a");
        fs::write(&from, "changed").unwrap();
        assert_eq!(copy_file(&fx.roots, &from, &to), Err(KitError::Changed));
        assert_eq!(fs::read_to_string(&to).unwrap(), "a");

        let skill = fx.home.join("skills").join("demo");
        fs::create_dir_all(skill.join("sub")).unwrap();
        fs::write(skill.join("SKILL.md"), "s").unwrap();
        fs::write(skill.join("sub").join("x.txt"), "x").unwrap();
        let other = fx.home.join("other-skills");
        let copy = copy_skill_dir(&fx.roots, &skill, &other).unwrap();
        assert_eq!(copy, other.join("demo"));
        assert_eq!(
            fs::read_to_string(copy.join("sub").join("x.txt")).unwrap(),
            "x"
        );
        assert_eq!(
            copy_skill_dir(&fx.roots, &skill, &other),
            Err(KitError::Changed)
        );
        // Not into itself.
        assert!(copy_skill_dir(&fx.roots, &skill, &skill.join("sub")).is_err());
        assert!(!skill.join("sub").join("demo").exists());
    }

    #[test]
    fn copy_outside_roots_refused() {
        let fx = fixture();
        let elsewhere = tempfile::tempdir().unwrap();
        let from = fx.home.join("a.md");
        fs::write(&from, "a").unwrap();
        let to = elsewhere.path().join("a.md");
        assert!(matches!(
            copy_file(&fx.roots, &from, &to),
            Err(KitError::Outside(_))
        ));
        let secret = elsewhere.path().join("secret.md");
        fs::write(&secret, "s").unwrap();
        assert!(matches!(
            copy_file(&fx.roots, &secret, &fx.home.join("s.md")),
            Err(KitError::Outside(_))
        ));
        assert!(!to.exists() && !fx.home.join("s.md").exists());
    }

    #[test]
    fn new_skill_uses_template() {
        let fx = fixture();
        let skills = fx.home.join("skills");
        let file = new_skill(&fx.roots, &skills, "my-skill", "Does a thing").unwrap();
        assert_eq!(file, skills.join("my-skill").join("SKILL.md"));
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            "---\nname: my-skill\ndescription: Does a thing\n---\n\n# my-skill\n\n## When to use\n\n## Steps\n"
        );
        assert_eq!(
            new_skill(&fx.roots, &skills, "my-skill", "again"),
            Err(KitError::Changed)
        );
        for bad in ["../evil", "Upper", "", "-lead", "a b"] {
            assert!(
                matches!(
                    new_skill(&fx.roots, &skills, bad, "d"),
                    Err(KitError::Parse(_))
                ),
                "{bad}"
            );
        }
        assert!(matches!(
            new_skill(&fx.roots, &skills, "ok", "two\nlines"),
            Err(KitError::Parse(_))
        ));
        assert!(matches!(
            new_skill(&fx.roots, &fx.home.join("..").join("skills"), "ok", "d"),
            Err(KitError::Outside(_))
        ));
    }
}
