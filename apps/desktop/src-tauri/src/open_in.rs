//! Open a worktree in another program: one of the person's Open In apps,
//! or the system file manager.

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use tauri::{AppHandle, State};
use xdev_ai::process::own_group;
use xdev_policy::Action;

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};
use crate::reveal::reveal;
use crate::settings::{OpenInSettings, SettingsSection};
use crate::settings_store;
use crate::workspace::{allowed, bad_arg, known_checkout};

/// Where `open_in` sends a folder.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum OpenTarget {
    /// The Open In app with this id.
    App {
        id: String,
    },
    FileManager,
}

/// The programs the Open In page offers as one-click presets, by command.
const PRESET_COMMANDS: [&str; 4] = ["code", "cursor", "zed", "windsurf"];

/// Whether one Open In app's program was found on this computer.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct OpenInFound {
    /// The app's id in the list; for a preset, its command.
    pub id: String,
    /// The program was found on `PATH` (or at its absolute path).
    pub found: bool,
}

/// The Open In list with, for each app, whether its program is installed.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct OpenInView {
    pub apps: Vec<crate::settings::OpenInApp>,
    /// One entry per app, same order as `apps`.
    pub found: Vec<OpenInFound>,
    /// The one-click presets, by command, found or not.
    pub presets: Vec<OpenInFound>,
}

/// `apps` with the same lookup `open_in` uses to start them.
fn detect(apps: &OpenInSettings, search: &Search) -> OpenInView {
    OpenInView {
        apps: apps.apps.clone(),
        found: apps
            .apps
            .iter()
            .map(|a| OpenInFound {
                id: a.id.clone(),
                found: search.find(&a.command).is_some(),
            })
            .collect(),
        presets: PRESET_COMMANDS
            .iter()
            .map(|c| OpenInFound {
                id: (*c).to_owned(),
                found: search.find(c).is_some(),
            })
            .collect(),
    }
}

/// Settings → Open In Apps as stored (the default list when nothing is),
/// each app marked found or not on this computer.
#[tauri::command(async)]
pub fn open_in_settings(app: AppHandle) -> OpenInView {
    detect(&settings_store::read(&app).open_in, &Search::from_env())
}

/// Stores the Open In list and returns what was stored; `bad_arg` names
/// the rule a refused list breaks.
#[tauri::command(async)]
pub fn open_in_settings_put(app: AppHandle, v: OpenInSettings) -> Result<OpenInSettings, CmdError> {
    v.check().map_err(bad_arg)?;
    settings_store::write(&app, &[SettingsSection::OpenIn], |s| s.open_in = v).map(|s| s.open_in)
}

/// Opens `path`, a repo or worktree the workspace knows, in `target`.
/// `worktree_unknown` for any other folder, `not_found` for an unknown app
/// id or a program that is not on `PATH`, the policy's error when it
/// refuses the command.
#[tauri::command(async)]
pub fn open_in(
    app: AppHandle,
    state: State<'_, AppState>,
    path: PathBuf,
    target: OpenTarget,
) -> Result<(), CmdError> {
    let apps = settings_store::read(&app).open_in;
    open_with(
        data_dir(&state)?,
        &apps,
        &path,
        &target,
        &Search::from_env(),
        start,
    )
}

/// What `open_in` starts; tests record it instead of starting it.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Launch {
    /// `program` with `args`, the folder last, run in the folder.
    App {
        program: PathBuf,
        args: Vec<OsString>,
        cwd: PathBuf,
    },
    FileManager(PathBuf),
}

fn open_with(
    data: &Path,
    apps: &OpenInSettings,
    path: &Path,
    target: &OpenTarget,
    search: &Search,
    run: impl FnOnce(Launch) -> io::Result<()>,
) -> Result<(), CmdError> {
    known_checkout(data, path)?;
    let launch = match target {
        OpenTarget::FileManager => Launch::FileManager(path.to_owned()),
        OpenTarget::App { id } => {
            let entry = apps
                .apps
                .iter()
                .find(|a| &a.id == id)
                .ok_or_else(|| not_found(id))?;
            let program = search
                .find(&entry.command)
                .ok_or_else(|| not_found(&entry.command))?;
            let folder = path.to_string_lossy().into_owned();
            let action = Action::RunCommand {
                program: entry.command.clone(),
                args: entry.args.iter().cloned().chain([folder]).collect(),
                cwd: path.to_owned(),
            };
            // The person picked the app from the menu: that is the approval.
            allowed(data, &action, true)?;
            Launch::App {
                program,
                args: entry
                    .args
                    .iter()
                    .map(OsString::from)
                    .chain([path.as_os_str().to_owned()])
                    .collect(),
                cwd: path.to_owned(),
            }
        }
    };
    run(launch).map_err(|e| CmdError {
        code: "io",
        detail: Some(e.to_string()),
    })
}

fn not_found(what: &str) -> CmdError {
    CmdError {
        code: "not_found",
        detail: Some(what.to_owned()),
    }
}

fn start(launch: Launch) -> io::Result<()> {
    match launch {
        Launch::FileManager(path) => reveal(&path, false),
        Launch::App { program, args, cwd } => {
            let mut child = app_command(&program, &args, &cwd).spawn()?;
            // Reaped off the command thread; an editor's exit code means nothing.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            Ok(())
        }
    }
}

/// The program with no console window and no pipes, in its own process
/// group so it outlives xDev. std quotes each argument, batch files too.
fn app_command(program: &Path, args: &[OsString], cwd: &Path) -> Command {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    own_group(&mut cmd);
    cmd
}

/// Where a bare program name is looked up: `PATH`, and on Windows the
/// `PATHEXT` endings, so `code` finds `code.cmd` (std adds only `.exe`).
struct Search {
    path: Option<OsString>,
    pathext: Option<OsString>,
}

impl Search {
    fn from_env() -> Search {
        Search {
            path: std::env::var_os("PATH"),
            pathext: std::env::var_os("PATHEXT"),
        }
    }

    fn find(&self, command: &str) -> Option<PathBuf> {
        let given = Path::new(command);
        if given.is_absolute() || given.components().count() > 1 {
            return self.runnable(given);
        }
        std::env::split_paths(self.path.as_deref()?)
            .filter(|dir| !dir.as_os_str().is_empty())
            .find_map(|dir| self.runnable(&dir.join(command)))
    }

    /// `base` itself on Unix; on Windows `base` when it already ends in a
    /// `PATHEXT` ending, else the first `base<ending>` that exists. An
    /// extensionless file (VS Code ships a shell script `code` next to
    /// `code.cmd`) does not run on Windows.
    fn runnable(&self, base: &Path) -> Option<PathBuf> {
        if !cfg!(windows) {
            return base.is_file().then(|| base.to_owned());
        }
        let endings = self.endings();
        let has_ending = base
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| endings.iter().any(|x| x[1..].eq_ignore_ascii_case(e)));
        if has_ending {
            return base.is_file().then(|| base.to_owned());
        }
        endings.iter().find_map(|ending| {
            let mut name = base.as_os_str().to_owned();
            name.push(ending);
            let candidate = PathBuf::from(name);
            candidate.is_file().then_some(candidate)
        })
    }

    fn endings(&self) -> Vec<String> {
        let raw = self
            .pathext
            .as_deref()
            .and_then(|s| s.to_str())
            .unwrap_or(".COM;.EXE;.BAT;.CMD");
        raw.split(';')
            .filter(|e| e.len() > 1 && e.starts_with('.'))
            .map(str::to_owned)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{self, OpenInApp};
    use crate::settings_store::SettingsStore;

    fn app(id: &str, command: &str) -> OpenInApp {
        OpenInApp {
            id: id.into(),
            label: id.into(),
            command: command.into(),
            args: Vec::new(),
        }
    }

    fn list(apps: Vec<OpenInApp>) -> OpenInSettings {
        OpenInSettings { apps }
    }

    fn store() -> (tempfile::TempDir, SettingsStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(dir.path().join(settings::FILE_NAME));
        (dir, store)
    }

    #[test]
    fn an_old_file_reads_the_default_list() {
        let (_dir, store) = store();
        std::fs::write(store.path(), r#"{"version":1,"git":{}}"#).unwrap();
        assert_eq!(store.read().open_in, OpenInSettings::default());
        assert_eq!(OpenInSettings::default().apps[0].command, "code");
    }

    #[test]
    fn a_broken_open_in_section_keeps_the_rest() {
        let (_dir, store) = store();
        std::fs::write(
            store.path(),
            r#"{"open_in":{"apps":7},"vault_prompted":true}"#,
        )
        .unwrap();
        let read = store.read();
        assert_eq!(read.open_in, OpenInSettings::default());
        assert!(read.vault_prompted);
    }

    #[test]
    fn detection_marks_each_app_found_or_missing() {
        let dir = tempfile::tempdir().unwrap();
        let name = if cfg!(windows) { "edit.cmd" } else { "edit" };
        std::fs::write(dir.path().join(name), b"").unwrap();
        let search = Search {
            path: Some(std::env::join_paths([dir.path()]).unwrap()),
            pathext: Some(".CMD".into()),
        };
        let apps = list(vec![app("a", "edit"), app("b", "no-such-editor")]);
        let view = detect(&apps, &search);
        assert_eq!(view.apps, apps.apps);
        let ids: Vec<_> = view.presets.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, PRESET_COMMANDS);
        assert!(view.presets.iter().all(|p| !p.found));
        assert_eq!(
            view.found,
            vec![
                OpenInFound {
                    id: "a".into(),
                    found: true
                },
                OpenInFound {
                    id: "b".into(),
                    found: false
                },
            ]
        );
    }

    #[test]
    fn the_list_rules() {
        assert_eq!(OpenInSettings::default().check(), Ok(()));
        let nine = (0..9).map(|i| app(&format!("a{i}"), "x")).collect();
        assert_eq!(list(nine).check(), Err("apps"));
        assert_eq!(list(vec![app("a", "x"), app("a", "y")]).check(), Err("id"));
        assert_eq!(list(vec![app(" ", "x")]).check(), Err("id"));
        let mut empty = app("a", "x");
        empty.label = String::new();
        assert_eq!(list(vec![empty]).check(), Err("label"));
        let mut long = app("a", "x");
        long.label = "é".repeat(41);
        assert_eq!(list(vec![long]).check(), Err("label"));
        assert_eq!(list(vec![app("a", "")]).check(), Err("command"));
        assert_eq!(list(vec![app("a", "code --new")]).check(), Err("command"));
        assert_eq!(
            list(vec![app("a", &"c".repeat(261))]).check(),
            Err("command")
        );
        let mut args = app("a", "x");
        args.args = vec!["-n".into(); 9];
        assert_eq!(list(vec![args]).check(), Err("args"));
        let mut arg = app("a", "x");
        arg.args = vec!["a".repeat(201)];
        assert_eq!(list(vec![arg]).check(), Err("args"));
    }

    #[test]
    fn a_command_with_spaces_must_be_an_existing_absolute_path() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("My Editor").join("edit.exe");
        let command = exe.to_string_lossy().into_owned();
        assert_eq!(list(vec![app("a", &command)]).check(), Err("command"));
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::write(&exe, b"").unwrap();
        assert_eq!(list(vec![app("a", &command)]).check(), Ok(()));
    }

    #[test]
    fn a_stored_list_keeps_order_and_args() {
        let (_dir, store) = store();
        let mut cursor = app("app-1", "cursor");
        cursor.args = vec!["-n".into(), "--reuse".into()];
        let next = list(vec![cursor, OpenInSettings::default().apps[0].clone()]);
        let saved = store.update(|s| s.open_in = next.clone()).unwrap();
        assert_eq!(saved.open_in, next);
        assert_eq!(store.read().open_in, next);
        let text = std::fs::read_to_string(store.path()).unwrap();
        assert!(text.contains("\"open_in\""), "{text}");
    }

    /// A registered repo in a folder with a space, and a `bin` folder that
    /// holds a `code` program (`code.cmd` on Windows, as VS Code ships it,
    /// next to an extensionless shell script).
    struct Fx {
        _tmp: tempfile::TempDir,
        data: PathBuf,
        repo: PathBuf,
        bin: PathBuf,
    }

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {out:?}");
    }

    fn fx() -> Fx {
        let tmp = crate::test_dirs::long_temp_dir("open in ");
        let repo = tmp.path().join("my repo");
        let data = tmp.path().join("data");
        let bin = tmp.path().join("bin");
        std::fs::create_dir(&repo).unwrap();
        std::fs::create_dir(&bin).unwrap();
        git(&repo, &["init", "-q"]);
        let mut reg = xdev_workspace::Registry::load(&data).unwrap();
        xdev_workspace::add_repo(&mut reg, &repo, 0).unwrap();
        reg.save(&data).unwrap();
        std::fs::write(bin.join("code"), "#!/bin/sh\n").unwrap();
        if cfg!(windows) {
            std::fs::write(
                bin.join("code.cmd"),
                "@echo off\r\n>\"%~dp0args.txt\" echo [%~1] [%~2]\r\n",
            )
            .unwrap();
        }
        Fx {
            _tmp: tmp,
            data,
            repo,
            bin,
        }
    }

    impl Fx {
        fn search(&self) -> Search {
            Search {
                path: Some(std::env::join_paths([&self.bin]).unwrap()),
                pathext: Some(".COM;.EXE;.BAT;.CMD".into()),
            }
        }

        /// The `code` program as the search finds it: the `PATHEXT` ending
        /// is appended as written there, and Windows names ignore case.
        fn code(&self) -> PathBuf {
            self.bin
                .join(if cfg!(windows) { "code.CMD" } else { "code" })
        }

        /// What `open_with` would start, or its error.
        fn open(
            &self,
            apps: &OpenInSettings,
            path: &Path,
            target: OpenTarget,
        ) -> Result<Launch, CmdError> {
            let mut seen = None;
            open_with(&self.data, apps, path, &target, &self.search(), |l| {
                seen = Some(l);
                Ok(())
            })?;
            Ok(seen.expect("launched"))
        }
    }

    fn vscode() -> OpenTarget {
        OpenTarget::App {
            id: "vscode".into(),
        }
    }

    #[test]
    fn a_folder_the_workspace_does_not_know_is_refused() {
        let fx = fx();
        let other = fx.repo.parent().unwrap().join("bin");
        let err = fx
            .open(&OpenInSettings::default(), &other, vscode())
            .unwrap_err();
        assert_eq!(err.code, "worktree_unknown");
    }

    #[test]
    fn an_unknown_app_or_program_is_not_found() {
        let fx = fx();
        let target = OpenTarget::App { id: "nope".into() };
        let err = fx
            .open(&OpenInSettings::default(), &fx.repo, target)
            .unwrap_err();
        assert_eq!(
            (err.code, err.detail.as_deref()),
            ("not_found", Some("nope"))
        );
        let missing = list(vec![app("vscode", "no-such-editor")]);
        let err = fx.open(&missing, &fx.repo, vscode()).unwrap_err();
        assert_eq!(
            (err.code, err.detail.as_deref()),
            ("not_found", Some("no-such-editor"))
        );
    }

    #[test]
    fn a_policy_error_starts_nothing() {
        let fx = fx();
        std::fs::write(fx.data.join("policy.json"), "{not json").unwrap();
        let err = fx
            .open(&OpenInSettings::default(), &fx.repo, vscode())
            .unwrap_err();
        assert_eq!(err.code, "policy_invalid");
    }

    #[test]
    fn the_command_line_is_the_args_then_the_folder_as_one_argument() {
        let fx = fx();
        let mut code = app("vscode", "code");
        code.args = vec!["-n".into()];
        let launch = fx.open(&list(vec![code]), &fx.repo, vscode()).unwrap();
        assert_eq!(
            launch,
            Launch::App {
                program: fx.code(),
                args: vec!["-n".into(), fx.repo.clone().into_os_string()],
                cwd: fx.repo.clone(),
            }
        );
        let audit = xdev_policy::read_audit(&fx.data).unwrap();
        let last = audit.last().unwrap();
        assert_eq!(
            last.action,
            Action::RunCommand {
                program: "code".into(),
                args: vec!["-n".into(), fx.repo.to_string_lossy().into_owned()],
                cwd: fx.repo.clone(),
            }
        );
        assert_eq!(last.verdict, xdev_policy::Verdict::Allow);
    }

    #[test]
    fn the_file_manager_gets_the_folder() {
        let fx = fx();
        let launch = fx
            .open(
                &OpenInSettings::default(),
                &fx.repo,
                OpenTarget::FileManager,
            )
            .unwrap();
        assert_eq!(launch, Launch::FileManager(fx.repo.clone()));
    }

    #[test]
    fn an_absolute_command_is_used_as_is() {
        let fx = fx();
        let command = fx.code().to_string_lossy().into_owned();
        let launch = fx.open(&list(vec![app("vscode", &command)]), &fx.repo, vscode());
        assert!(matches!(launch, Ok(Launch::App { program, .. }) if program == fx.code()));
    }

    #[cfg(windows)]
    #[test]
    fn a_batch_shim_gets_a_folder_with_spaces_as_one_argument() {
        let fx = fx();
        let args = [OsString::from("-n"), fx.repo.clone().into_os_string()];
        let status = app_command(&fx.code(), &args, &fx.repo).status().unwrap();
        assert!(status.success());
        let seen = std::fs::read_to_string(fx.bin.join("args.txt")).unwrap();
        assert_eq!(seen.trim_end(), format!("[-n] [{}]", fx.repo.display()));
    }
}
