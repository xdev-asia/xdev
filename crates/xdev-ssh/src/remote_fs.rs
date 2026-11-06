//! The files and git status of a folder on a host, through one SFTP session
//! and one exec channel. Every call returns the same types the local
//! worktree calls do, so the editor and the file tree need no remote case.

use std::io::Write;
use std::time::Duration;

use xdev_git::FileStatus;
use xdev_workspace::{
    Eol, FileList, FileText, LIST_MAX, READ_MAX, WriteOutcome, content_hash, file_text,
    text_with_eol, too_large_text,
};

use crate::chan::ExecChannel;
use crate::remote_view::{RemoteDir, RemoteDirListing};
use crate::rpath::{RemoteError, join_rel, parent_of, sh_quote};
use crate::sftp::{EntryKind, Sftp};

/// How long a file list may take.
pub const LIST_TIMEOUT: Duration = Duration::from_secs(20);

/// How long `git status` and the probe may take.
pub const CMD_TIMEOUT: Duration = Duration::from_secs(20);

/// The most folders one browse lists.
pub const DIRS_MAX: usize = 2000;

/// How deep a remove goes before it gives up.
pub const REMOVE_DEPTH: usize = 64;

/// What the host has, from one probe after connecting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Probe {
    pub home: String,
    pub git: bool,
    pub tmux: bool,
}

pub struct RemoteFs<SW: Write, CW: Write> {
    pub sftp: Sftp<SW>,
    pub chan: ExecChannel<CW>,
}

/// 8 random hex digits for a temp name.
fn tmp_suffix() -> Result<String, RemoteError> {
    let mut b = [0u8; 4];
    getrandom::fill(&mut b).map_err(|e| RemoteError::Io(e.to_string()))?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

/// The paths of a `-z` list, without a leading `./`, sorted and deduped,
/// at most `LIST_MAX`.
fn file_list(out: &[u8]) -> FileList {
    let mut files: Vec<String> = out
        .split(|&b| b == 0)
        .filter_map(|p| std::str::from_utf8(p).ok())
        .map(|p| p.strip_prefix("./").unwrap_or(p))
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
        .collect();
    files.sort();
    files.dedup();
    let truncated = files.len() > LIST_MAX;
    files.truncate(LIST_MAX);
    FileList { files, truncated }
}

/// The script for `list_files`: tracked and untracked-not-ignored files in a
/// git checkout, every file but `.git` elsewhere. Exit 3 when the folder is
/// not there. In a subshell, so the `cd` does not stay.
fn list_script(root: &str) -> String {
    format!(
        "( cd {} || exit 3; if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then git ls-files -z --cached --others --exclude-standard; else find . -type f -not -path '*/.git/*' -print0; fi )",
        sh_quote(root)
    )
}

/// The script for `git_status`: exit 127 without git.
fn status_script(root: &str) -> String {
    format!(
        "if command -v git >/dev/null 2>&1; then git -C {} status --porcelain=v1 -z --no-renames --untracked-files=all; else (exit 127); fi",
        sh_quote(root)
    )
}

const PROBE_SCRIPT: &str = "printf '%s\\n' \"$HOME\"; if command -v git >/dev/null 2>&1; then echo git=1; else echo git=0; fi; if command -v tmux >/dev/null 2>&1; then echo tmux=1; else echo tmux=0; fi";

fn parse_probe(out: &[u8]) -> Probe {
    let text = String::from_utf8_lossy(out);
    let mut lines = text.lines();
    let home = lines.next().unwrap_or_default().to_owned();
    let rest: Vec<&str> = lines.collect();
    Probe {
        home,
        git: rest.contains(&"git=1"),
        tmux: rest.contains(&"tmux=1"),
    }
}

impl<SW: Write, CW: Write> RemoteFs<SW, CW> {
    pub fn new(sftp: Sftp<SW>, chan: ExecChannel<CW>) -> Self {
        Self { sftp, chan }
    }

    /// The file `rel` of the remote folder `root`, read like a local one.
    pub fn read_file(&mut self, root: &str, rel: &str) -> Result<FileText, RemoteError> {
        let path = join_rel(root, rel)?;
        let attrs = self.sftp.stat(&path)?;
        if attrs.is_dir() {
            return Err(RemoteError::BadPath(rel.to_owned()));
        }
        let size = attrs.size.unwrap_or(0);
        if size > READ_MAX {
            return Ok(too_large_text(rel, size));
        }
        match self.sftp.read_file(&path, READ_MAX) {
            Ok(bytes) => Ok(file_text(rel, bytes)),
            // It grew since the stat.
            Err(RemoteError::TooLarge) => Ok(too_large_text(rel, READ_MAX + 1)),
            Err(e) => Err(e),
        }
    }

    /// Saves like a local save: `Conflict` when the file on the host is not
    /// the one the editor loaded (`expected`, `None` for a new file), else a
    /// temp file next to it, then a rename over it.
    pub fn write_file(
        &mut self,
        root: &str,
        rel: &str,
        text: &str,
        eol: Eol,
        expected: Option<&str>,
    ) -> Result<WriteOutcome, RemoteError> {
        let path = join_rel(root, rel)?;
        let (on_disk, mode) = match self.sftp.stat(&path) {
            Ok(a) if a.is_dir() => return Err(RemoteError::BadPath(rel.to_owned())),
            Ok(a) => {
                let bytes = self.sftp.read_file(&path, READ_MAX)?;
                (
                    Some(content_hash(&bytes)),
                    a.permissions.map(|p| p & 0o7777),
                )
            }
            Err(RemoteError::NotFound) => (None, None),
            Err(e) => return Err(e),
        };
        if on_disk.as_deref() != expected {
            return Ok(WriteOutcome::Conflict {
                disk_hash: on_disk.unwrap_or_default(),
            });
        }
        let bytes = text_with_eol(text, eol);
        let dir = parent_of(&path).unwrap_or_else(|| "/".to_owned());
        let name = path.rsplit('/').next().unwrap_or_default();
        let tmp = format!(
            "{}/{name}.xdev-tmp-{}",
            dir.trim_end_matches('/'),
            tmp_suffix()?
        );
        let placed = (|| {
            self.sftp.write_file_mode(&tmp, bytes.as_bytes(), mode)?;
            if !self.sftp.has_posix_rename() && on_disk.is_some() {
                // A v3 rename does not replace; this one is not atomic.
                self.sftp.remove(&path)?;
            }
            self.sftp.rename(&tmp, &path)
        })();
        if let Err(e) = placed {
            // Ours, never the user's file.
            let _ = self.sftp.remove(&tmp);
            return Err(e);
        }
        Ok(WriteOutcome::Saved {
            hash: content_hash(bytes.as_bytes()),
        })
    }

    /// An empty file or a folder; `Exists` when the name is taken.
    pub fn create_entry(&mut self, root: &str, rel: &str, dir: bool) -> Result<(), RemoteError> {
        let path = join_rel(root, rel)?;
        if self.sftp.try_lstat(&path)?.is_some() {
            return Err(RemoteError::Exists);
        }
        if dir {
            self.sftp.mkdir(&path)
        } else {
            self.sftp.create_new(&path)
        }
    }

    /// `Exists` when `to` is taken; a folder cannot go inside itself.
    pub fn rename_entry(&mut self, root: &str, from: &str, to: &str) -> Result<(), RemoteError> {
        let src = join_rel(root, from)?;
        let dst = join_rel(root, to)?;
        if src == dst {
            return Ok(());
        }
        if dst.starts_with(&format!("{src}/")) {
            return Err(RemoteError::BadPath(to.to_owned()));
        }
        self.sftp.lstat(&src)?;
        if self.sftp.try_lstat(&dst)?.is_some() {
            return Err(RemoteError::Exists);
        }
        self.sftp.rename(&src, &dst)
    }

    /// Deletes for good (SFTP has no trash): a file, a link, or a folder with
    /// everything in it, at most `REMOVE_DEPTH` deep. Links are removed, not
    /// followed.
    pub fn remove_entry(&mut self, root: &str, rel: &str) -> Result<(), RemoteError> {
        let path = join_rel(root, rel)?;
        let attrs = self.sftp.lstat(&path)?;
        if attrs.is_dir() {
            self.remove_tree(&path, 0)
        } else {
            self.sftp.remove(&path)
        }
    }

    fn remove_tree(&mut self, dir: &str, depth: usize) -> Result<(), RemoteError> {
        if depth >= REMOVE_DEPTH {
            return Err(RemoteError::Io(format!(
                "deeper than {REMOVE_DEPTH} folders"
            )));
        }
        for e in self.sftp.read_dir(dir)? {
            let child = format!("{}/{}", dir.trim_end_matches('/'), e.name);
            if e.kind == EntryKind::Dir {
                self.remove_tree(&child, depth + 1)?;
            } else {
                self.sftp.remove(&child)?;
            }
        }
        self.sftp.rmdir(dir)
    }

    /// The files of the folder for quick open: what git keeps in a checkout,
    /// every file but `.git` elsewhere; at most `LIST_MAX`, within 20 s.
    pub fn list_files(&mut self, root: &str) -> Result<FileList, RemoteError> {
        let out = self.chan.run(&list_script(root), LIST_TIMEOUT)?;
        match out.code {
            0 => Ok(file_list(&out.stdout)),
            3 => Err(RemoteError::NotFound),
            // `find` exits non-zero on an unreadable folder but lists the rest.
            _ if !out.stdout.is_empty() => Ok(file_list(&out.stdout)),
            c => Err(RemoteError::Io(format!("list exited {c}"))),
        }
    }

    /// The subfolders of `path` (resolved first), sorted by name, at most
    /// `DIRS_MAX`. Links are left out: telling a link to a folder costs a
    /// stat each.
    pub fn list_dirs(&mut self, path: &str) -> Result<RemoteDirListing, RemoteError> {
        let path = self.sftp.realpath(path)?;
        if !self.sftp.stat(&path)?.is_dir() {
            return Err(RemoteError::BadPath(path));
        }
        let mut names: Vec<String> = self
            .sftp
            .read_dir(&path)?
            .into_iter()
            .filter(|e| e.kind == EntryKind::Dir)
            .map(|e| e.name)
            .collect();
        names.sort();
        let truncated = names.len() > DIRS_MAX;
        names.truncate(DIRS_MAX);
        let base = path.trim_end_matches('/');
        let dirs = names
            .into_iter()
            .map(|name| RemoteDir {
                path: format!("{base}/{name}"),
                name,
            })
            .collect();
        Ok(RemoteDirListing {
            parent: parent_of(&path),
            path,
            dirs,
            truncated,
        })
    }

    /// The login folder.
    pub fn home(&mut self) -> Result<String, RemoteError> {
        self.sftp.realpath(".")
    }

    /// Every file of the checkout at `root` that differs from `HEAD`; empty
    /// when `root` is not in a git checkout; `NoGit` without git.
    pub fn git_status(&mut self, root: &str) -> Result<Vec<FileStatus>, RemoteError> {
        let out = self.chan.run(&status_script(root), CMD_TIMEOUT)?;
        match out.code {
            0 => Ok(xdev_git::parse_status_z(&out.stdout, "")),
            127 => Err(RemoteError::NoGit),
            128 => Ok(Vec::new()),
            c => Err(RemoteError::Io(format!("git status exited {c}"))),
        }
    }

    /// `$HOME` and whether git and tmux are installed.
    pub fn probe(&mut self) -> Result<Probe, RemoteError> {
        let out = self.chan.run(PROBE_SCRIPT, CMD_TIMEOUT)?;
        Ok(parse_probe(&out.stdout))
    }
}

#[cfg(test)]
mod tests {
    use xdev_git::ChangeKind;

    use super::*;
    use crate::chan::fake::Shell;
    use crate::sftp::fake::*;

    const ROOT: &str = "/home/dev/app";

    fn fs(
        sftp_replies: &[Vec<u8>],
        posix: bool,
        answers: Vec<(Vec<u8>, i32)>,
    ) -> (RemoteFs<Sink, Shell>, Sink, Shell) {
        let exts: &[(&str, &str)] = if posix {
            &[("posix-rename@openssh.com", "1")]
        } else {
            &[]
        };
        let (sftp, sink, _pipe) = session(exts, sftp_replies);
        let shell = Shell::new(answers);
        let chan = ExecChannel::new(shell.out.clone(), shell.clone()).unwrap();
        (RemoteFs::new(sftp, chan), sink, shell)
    }

    /// The path strings each request carried, by type.
    fn kinds(sink: &Sink) -> Vec<u8> {
        sink.packets().iter().map(|p| p.0).collect()
    }

    #[test]
    fn write_file_conflicts_when_the_hash_differs() {
        let (mut f, sink, _) = fs(
            &[
                attrs(1, 3, FILE),
                handle(2, b"r"),
                data(3, b"new"),
                eof(4),
                ok(5),
            ],
            true,
            vec![],
        );
        let out = f
            .write_file(
                ROOT,
                "README.md",
                "mine",
                Eol::Lf,
                Some(&content_hash(b"old")),
            )
            .unwrap();
        assert_eq!(
            out,
            WriteOutcome::Conflict {
                disk_hash: content_hash(b"new")
            }
        );
        // Stat, open, read, read, close: nothing written.
        assert_eq!(kinds(&sink), [1, 17, 3, 5, 5, 4]);
    }

    #[test]
    fn write_file_conflicts_when_a_new_file_exists() {
        let (mut f, _, _) = fs(
            &[
                attrs(1, 1, FILE),
                handle(2, b"r"),
                data(3, b"x"),
                eof(4),
                ok(5),
            ],
            true,
            vec![],
        );
        let out = f.write_file(ROOT, "a.txt", "y", Eol::Lf, None).unwrap();
        assert_eq!(
            out,
            WriteOutcome::Conflict {
                disk_hash: content_hash(b"x")
            }
        );
    }

    #[test]
    fn write_file_saves_through_a_temp_file_and_a_rename() {
        let (mut f, sink, _) = fs(
            &[
                attrs(1, 3, FILE),
                handle(2, b"r"),
                data(3, b"old"),
                eof(4),
                ok(5),
                // The temp file: open, write, close; then the rename.
                handle(6, b"w"),
                ok(7),
                ok(8),
                ok(9),
            ],
            true,
            vec![],
        );
        let out = f
            .write_file(
                ROOT,
                "src/main.ts",
                "a\nb\n",
                Eol::Crlf,
                Some(&content_hash(b"old")),
            )
            .unwrap();
        assert_eq!(
            out,
            WriteOutcome::Saved {
                hash: content_hash(b"a\r\nb\r\n")
            }
        );
        let p = sink.packets();
        assert_eq!(kinds(&sink), [1, 17, 3, 5, 5, 4, 3, 6, 4, 200]);
        let open_tmp = String::from_utf8_lossy(&p[6].1).into_owned();
        assert!(
            open_tmp.contains("/home/dev/app/src/main.ts.xdev-tmp-"),
            "{open_tmp}"
        );
        // The new file keeps the old one's mode.
        assert!(p[6].1.ends_with(&[0, 0, 0, 4, 0, 0, 0x01, 0xa4]));
        let written = &p[7].1;
        assert!(written.ends_with(b"a\r\nb\r\n"));
        let rename = String::from_utf8_lossy(&p[9].1).into_owned();
        assert!(
            rename.contains("posix-rename@openssh.com")
                && rename.ends_with("/home/dev/app/src/main.ts")
        );
    }

    #[test]
    fn write_file_new_without_posix_rename() {
        let (mut f, sink, _) = fs(
            &[
                status(1, 2, "No such file"),
                handle(2, b"w"),
                ok(3),
                ok(4),
                ok(5),
            ],
            false,
            vec![],
        );
        let out = f.write_file(ROOT, "new.txt", "hi", Eol::Lf, None).unwrap();
        assert_eq!(
            out,
            WriteOutcome::Saved {
                hash: content_hash(b"hi")
            }
        );
        assert_eq!(kinds(&sink), [1, 17, 3, 6, 4, 18]);
    }

    #[test]
    fn write_file_removes_the_temp_file_when_the_rename_fails() {
        let (mut f, sink, _) = fs(
            &[
                status(1, 2, ""),
                handle(2, b"w"),
                ok(3),
                ok(4),
                status(5, 3, "denied"),
                ok(6),
            ],
            true,
            vec![],
        );
        assert_eq!(
            f.write_file(ROOT, "n.txt", "hi", Eol::Lf, None),
            Err(RemoteError::Denied)
        );
        let p = sink.packets();
        assert_eq!(p.last().unwrap().0, 13);
        assert!(String::from_utf8_lossy(&p.last().unwrap().1).contains("n.txt.xdev-tmp-"));
    }

    #[test]
    fn write_file_refuses_paths_outside_the_root() {
        let (mut f, sink, _) = fs(&[], true, vec![]);
        assert!(matches!(
            f.write_file(ROOT, "../x", "", Eol::Lf, None),
            Err(RemoteError::BadPath(_))
        ));
        assert_eq!(kinds(&sink), [1]);
    }

    #[test]
    fn read_file_uses_the_local_rules() {
        let (mut f, _, _) = fs(
            &[
                attrs(1, 6, FILE),
                handle(2, b"r"),
                data(3, b"a\r\nb\r\n"),
                eof(4),
                ok(5),
                attrs(6, READ_MAX + 1, FILE),
            ],
            true,
            vec![],
        );
        let t = f.read_file(ROOT, "x.txt").unwrap();
        assert_eq!(t.text.as_deref(), Some("a\r\nb\r\n"));
        assert_eq!(t.eol, Eol::Crlf);
        assert_eq!(t.hash, content_hash(b"a\r\nb\r\n"));
        let big = f.read_file(ROOT, "big.bin").unwrap();
        assert_eq!(big.kind, xdev_workspace::FileKind::TooLarge);
    }

    #[test]
    fn git_status_parses_the_z_blob() {
        let blob = b" M src/main.ts\0?? notes.md\0D  old.txt\0".to_vec();
        let (mut f, _, shell) = fs(
            &[],
            true,
            vec![(blob, 0), (Vec::new(), 127), (Vec::new(), 128)],
        );
        assert_eq!(
            f.git_status("/home/dev/it's").unwrap(),
            [
                FileStatus {
                    path: "notes.md".into(),
                    kind: ChangeKind::Added
                },
                FileStatus {
                    path: "old.txt".into(),
                    kind: ChangeKind::Deleted
                },
                FileStatus {
                    path: "src/main.ts".into(),
                    kind: ChangeKind::Modified
                },
            ]
        );
        assert!(shell.scripts.lock().unwrap()[0].contains("git -C '/home/dev/it'\\''s' status --porcelain=v1 -z --no-renames --untracked-files=all"));
        assert_eq!(f.git_status(ROOT), Err(RemoteError::NoGit));
        assert_eq!(f.git_status(ROOT), Ok(Vec::new()));
    }

    #[test]
    fn list_files_strips_and_caps() {
        let (mut f, _, shell) = fs(
            &[],
            true,
            vec![(b"b.ts\0./a.ts\0b.ts\0".to_vec(), 0), (Vec::new(), 3)],
        );
        assert_eq!(
            f.list_files(ROOT).unwrap(),
            FileList {
                files: vec!["a.ts".into(), "b.ts".into()],
                truncated: false
            }
        );
        assert!(shell.scripts.lock().unwrap()[0].starts_with("( cd '/home/dev/app' || exit 3;"));
        assert_eq!(f.list_files(ROOT), Err(RemoteError::NotFound));
        let many: Vec<u8> = (0..LIST_MAX + 1)
            .flat_map(|i| format!("f{i}\0").into_bytes())
            .collect();
        let l = file_list(&many);
        assert!(l.truncated);
        assert_eq!(l.files.len(), LIST_MAX);
    }

    #[test]
    fn list_dirs_keeps_folders_sorted() {
        let (mut f, _, _) = fs(
            &[
                names(1, &[("/home/dev", 0, DIR)]),
                attrs(2, 0, DIR),
                handle(3, b"d"),
                names(4, &[("zeta", 0, DIR), ("a.txt", 1, FILE), ("app", 0, DIR)]),
                eof(5),
                ok(6),
            ],
            true,
            vec![],
        );
        let l = f.list_dirs("~").unwrap();
        assert_eq!(l.path, "/home/dev");
        assert_eq!(l.parent.as_deref(), Some("/home"));
        assert_eq!(
            l.dirs,
            [
                RemoteDir {
                    name: "app".into(),
                    path: "/home/dev/app".into()
                },
                RemoteDir {
                    name: "zeta".into(),
                    path: "/home/dev/zeta".into()
                },
            ]
        );
        assert!(!l.truncated);
    }

    #[test]
    fn remove_entry_goes_down_the_tree() {
        let (mut f, sink, _) = fs(
            &[
                attrs(1, 0, DIR),
                handle(2, b"d"),
                names(3, &[("a.txt", 1, FILE)]),
                eof(4),
                ok(5),
                ok(6),
                ok(7),
            ],
            true,
            vec![],
        );
        f.remove_entry(ROOT, "src").unwrap();
        assert_eq!(kinds(&sink), [1, 7, 11, 12, 12, 4, 13, 15]);
    }

    #[test]
    fn create_and_rename_refuse_taken_names() {
        let (mut f, _, _) = fs(
            &[attrs(1, 0, FILE), attrs(2, 0, FILE), attrs(3, 0, FILE)],
            true,
            vec![],
        );
        assert_eq!(f.create_entry(ROOT, "a", false), Err(RemoteError::Exists));
        assert_eq!(f.rename_entry(ROOT, "a", "b"), Err(RemoteError::Exists));
        assert!(matches!(
            f.rename_entry(ROOT, "d", "d/e"),
            Err(RemoteError::BadPath(_))
        ));
    }

    #[test]
    fn probe_reads_home_and_tools() {
        let (mut f, _, _) = fs(&[], true, vec![(b"/home/dev\ngit=1\ntmux=0\n".to_vec(), 0)]);
        assert_eq!(
            f.probe().unwrap(),
            Probe {
                home: "/home/dev".into(),
                git: true,
                tmux: false
            }
        );
    }
}
