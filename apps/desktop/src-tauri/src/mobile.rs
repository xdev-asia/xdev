//! Simulators for the Run targets menu: lists installed iOS simulators
//! (macOS) and Android AVDs, boots one, and builds the commands the UI types
//! into terminal tabs. Building and installing apps is out of scope.
//!
//! Every external program goes through an injected runner, so tests never
//! start `xcrun`, `emulator` or `adb`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::commands::CmdError;

/// A tool call: program, arguments, timeout; the stdout, or `None` on failure.
pub(crate) type Runner<'a> = &'a dyn Fn(&str, &[&str], Duration) -> Option<String>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum SimPlatform {
    Ios,
    Android,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum SimState {
    Booted,
    Shutdown,
    Unknown,
}

/// One simulator or AVD. `id` is the UDID (iOS) or the AVD name (Android).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SimDevice {
    pub platform: SimPlatform,
    pub id: String,
    pub name: String,
    pub runtime: Option<String>,
    pub state: SimState,
    /// Android only: the `emulator-NNNN` serial while it runs.
    pub serial: Option<String>,
}

/// `None` means the tool is missing; each problem is an i18n key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SimList {
    pub ios: Option<Vec<SimDevice>>,
    pub android: Option<Vec<SimDevice>>,
    pub problems: Vec<String>,
}

/// What the UI sends back to boot one; checked against a fresh list.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SimRef {
    pub platform: SimPlatform,
    pub id: String,
}

/// The commands for a booted device. `tab_command` is typed into a new shell
/// tab (a long-running emulator); `log_command` into a second tab.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SimLaunch {
    pub tab_command: Option<String>,
    pub log_command: String,
    pub title: String,
}

/// The shell the tab types into.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Shell {
    Posix,
    PowerShell,
}

impl Shell {
    pub(crate) fn host() -> Shell {
        if cfg!(windows) {
            Shell::PowerShell
        } else {
            Shell::Posix
        }
    }

    fn quote(self, text: &str) -> String {
        match self {
            Shell::Posix | Shell::PowerShell => {
                let plain = !text.is_empty()
                    && text
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || "_@%+=:,./-".contains(c));
                match (plain, self) {
                    (true, _) => text.to_owned(),
                    (false, Shell::Posix) => format!("'{}'", text.replace('\'', "'\\''")),
                    (false, Shell::PowerShell) => format!("'{}'", text.replace('\'', "''")),
                }
            }
        }
    }

    /// `program` run with `args`; PowerShell needs `&` before a quoted path.
    fn command(self, program: &str, args: &[&str]) -> String {
        let mut out = String::new();
        if self == Shell::PowerShell {
            out.push_str("& ");
        }
        out.push_str(&self.quote(program));
        for a in args {
            out.push(' ');
            out.push_str(&self.quote(a));
        }
        out
    }

    fn then(self, first: String, second: String) -> String {
        match self {
            Shell::Posix => format!("{first} && {second}"),
            Shell::PowerShell => format!("{first}; {second}"),
        }
    }
}

// --- iOS ---

#[derive(Deserialize)]
struct SimctlOut {
    #[serde(default)]
    devices: std::collections::BTreeMap<String, Vec<SimctlDevice>>,
}

#[derive(Deserialize)]
struct SimctlDevice {
    udid: String,
    name: String,
    #[serde(default)]
    state: String,
    #[serde(default, rename = "isAvailable")]
    is_available: Option<bool>,
}

/// "com.apple.CoreSimulator.SimRuntime.iOS-18-0" -> "iOS 18.0".
fn runtime_label(key: &str) -> Option<String> {
    let tail = key.rsplit('.').next()?;
    let (os, version) = tail.split_once('-')?;
    (!os.is_empty() && !version.is_empty()).then(|| format!("{os} {}", version.replace('-', ".")))
}

/// Devices of `xcrun simctl list devices available --json`; unknown fields
/// and bad input are ignored (empty list).
pub(crate) fn parse_simctl(json: &str) -> Vec<SimDevice> {
    let Ok(out) = serde_json::from_str::<SimctlOut>(json) else {
        return Vec::new();
    };
    let mut list = Vec::new();
    for (runtime, devices) in out.devices {
        let runtime = runtime_label(&runtime);
        for d in devices {
            if d.is_available == Some(false) {
                continue;
            }
            list.push(SimDevice {
                platform: SimPlatform::Ios,
                id: d.udid,
                name: d.name,
                runtime: runtime.clone(),
                state: match d.state.as_str() {
                    "Booted" => SimState::Booted,
                    "Shutdown" => SimState::Shutdown,
                    _ => SimState::Unknown,
                },
                serial: None,
            });
        }
    }
    list
}

// --- Android ---

/// Names from `emulator -list-avds`: one per line; blank lines and the
/// `INFO |` notes the tool prints are skipped.
pub(crate) fn parse_avds(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.contains(' ') && !l.contains('|'))
        .map(str::to_owned)
        .collect()
}

/// Emulator serials of `adb devices` that are online.
pub(crate) fn parse_adb_devices(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .skip_while(|l| !l.starts_with("List of devices"))
        .skip(1)
        .filter_map(|l| {
            let mut parts = l.split_whitespace();
            let serial = parts.next()?;
            (serial.starts_with("emulator-") && parts.next() == Some("device"))
                .then(|| serial.to_owned())
        })
        .collect()
}

/// The AVD name of `adb -s <serial> emu avd name`: the first line.
pub(crate) fn parse_avd_name(stdout: &str) -> Option<String> {
    let line = stdout.lines().next()?.trim();
    (!line.is_empty() && !line.contains(' ') && line != "OK").then(|| line.to_owned())
}

/// Where the Android tools may be: injected so tests need no real disk.
pub(crate) struct Sdk<'a> {
    pub find_program: &'a dyn Fn(&str) -> Option<PathBuf>,
    pub var: &'a dyn Fn(&str) -> Option<String>,
    pub is_file: &'a dyn Fn(&Path) -> bool,
    pub home: Option<PathBuf>,
}

impl Sdk<'_> {
    /// `tool` ("emulator" or "adb") in `dir` ("emulator" or "platform-tools"):
    /// PATH, `$ANDROID_HOME`, `$ANDROID_SDK_ROOT`, then the OS default folder.
    pub(crate) fn find(&self, tool: &str, dir: &str) -> Option<PathBuf> {
        if let Some(p) = (self.find_program)(tool) {
            return Some(p);
        }
        let mut roots: Vec<PathBuf> = ["ANDROID_HOME", "ANDROID_SDK_ROOT"]
            .iter()
            .filter_map(|v| (self.var)(v))
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .collect();
        if cfg!(windows) {
            if let Some(local) = (self.var)("LOCALAPPDATA").filter(|v| !v.is_empty()) {
                roots.push(PathBuf::from(local).join("Android").join("Sdk"));
            }
        } else if let Some(home) = &self.home {
            roots.push(if cfg!(target_os = "macos") {
                home.join("Library").join("Android").join("sdk")
            } else {
                home.join("Android").join("Sdk")
            });
        }
        let file = if cfg!(windows) {
            format!("{tool}.exe")
        } else {
            tool.to_owned()
        };
        roots
            .into_iter()
            .map(|r| r.join(dir).join(&file))
            .find(|p| (self.is_file)(p))
    }
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

const TOOL_TIMEOUT: Duration = Duration::from_secs(10);
const QUICK_TIMEOUT: Duration = Duration::from_secs(2);

fn list_ios(run: Runner<'_>) -> Option<Vec<SimDevice>> {
    let out = run(
        "xcrun",
        &["simctl", "list", "devices", "available", "--json"],
        TOOL_TIMEOUT,
    )?;
    Some(parse_simctl(&out))
}

fn list_android(sdk: &Sdk<'_>, run: Runner<'_>) -> Option<Vec<SimDevice>> {
    let emulator = path_str(&sdk.find("emulator", "emulator")?);
    let avds = parse_avds(&run(&emulator, &["-list-avds"], TOOL_TIMEOUT)?);
    // Without adb nothing can be told as running: the state stays Unknown.
    let adb = sdk.find("adb", "platform-tools").map(|p| path_str(&p));
    let running: Option<Vec<(String, Option<String>)>> = adb.as_deref().and_then(|adb| {
        let serials = parse_adb_devices(&run(adb, &["devices"], TOOL_TIMEOUT)?);
        Some(
            serials
                .into_iter()
                .map(|s| {
                    let name = run(adb, &["-s", &s, "emu", "avd", "name"], QUICK_TIMEOUT)
                        .and_then(|o| parse_avd_name(&o));
                    (s, name)
                })
                .collect(),
        )
    });
    Some(
        avds.into_iter()
            .map(|name| {
                let serial = running.as_ref().and_then(|r| {
                    r.iter()
                        .find(|(_, n)| n.as_deref() == Some(name.as_str()))
                        .map(|(s, _)| s.clone())
                });
                let state = match (&running, &serial) {
                    (_, Some(_)) => SimState::Booted,
                    (Some(r), None) if r.iter().all(|(_, n)| n.is_some()) => SimState::Shutdown,
                    _ => SimState::Unknown,
                };
                SimDevice {
                    platform: SimPlatform::Android,
                    id: name.clone(),
                    name: name.clone(),
                    runtime: None,
                    state,
                    serial,
                }
            })
            .collect(),
    )
}

/// Both lists; `ios_supported` is false off macOS (then iOS is just absent
/// and not reported as a problem).
pub(crate) fn list_all(ios_supported: bool, sdk: &Sdk<'_>, run: Runner<'_>) -> SimList {
    let mut problems = Vec::new();
    let ios = if ios_supported {
        let list = list_ios(run);
        if list.is_none() {
            problems.push("targets.sim.noXcode".to_owned());
        }
        list
    } else {
        None
    };
    let android = list_android(sdk, run);
    if android.is_none() {
        problems.push("targets.sim.noAndroid".to_owned());
    }
    SimList {
        ios,
        android,
        problems,
    }
}

/// The commands for `device`. Android needs the tool paths.
pub(crate) fn sim_launch(
    device: &SimDevice,
    emulator: Option<&Path>,
    adb: Option<&Path>,
    shell: Shell,
    log_title: &dyn Fn(&str) -> String,
) -> Result<SimLaunch, CmdError> {
    let title = log_title(&device.name);
    match device.platform {
        SimPlatform::Ios => Ok(SimLaunch {
            tab_command: None,
            log_command: shell.command(
                "xcrun",
                &[
                    "simctl", "spawn", &device.id, "log", "stream", "--style", "compact",
                    "--level", "info",
                ],
            ),
            title,
        }),
        SimPlatform::Android => {
            let (Some(emulator), Some(adb)) = (emulator, adb) else {
                return Err(tool_missing());
            };
            let (emulator, adb) = (path_str(emulator), path_str(adb));
            let mut base: Vec<&str> = Vec::new();
            if let Some(serial) = &device.serial {
                base.extend(["-s", serial]);
            }
            let wait = [&base[..], &["wait-for-device"]].concat();
            let logcat = [&base[..], &["logcat", "-v", "color"]].concat();
            Ok(SimLaunch {
                tab_command: Some(shell.command(&emulator, &["-avd", &device.id])),
                log_command: shell.then(shell.command(&adb, &wait), shell.command(&adb, &logcat)),
                title,
            })
        }
    }
}

pub(crate) fn tool_missing() -> CmdError {
    CmdError {
        code: "sim_tool_missing",
        detail: None,
    }
}

/// Boots `target` after finding it in a fresh list. Returns the device and
/// whether its tool paths are needed by the caller (`sim_launch`).
pub(crate) fn find_device(list: &SimList, target: &SimRef) -> Result<SimDevice, CmdError> {
    let devices = match target.platform {
        SimPlatform::Ios => list.ios.as_deref(),
        SimPlatform::Android => list.android.as_deref(),
    };
    let Some(devices) = devices else {
        return Err(tool_missing());
    };
    devices
        .iter()
        .find(|d| d.id == target.id)
        .cloned()
        .ok_or(CmdError {
            code: "sim_not_found",
            detail: None,
        })
}

/// `xcrun simctl boot <udid>` then `open -a Simulator`. "Already booted" is fine.
pub(crate) fn boot_ios(udid: &str, run: Runner<'_>) {
    // `capture` reports a failed boot as None; a booted device fails the same
    // way, so a failure is not an error: `open` and the log tab show the rest.
    let _ = run("xcrun", &["simctl", "boot", udid], TOOL_TIMEOUT);
    let _ = run("open", &["-a", "Simulator"], TOOL_TIMEOUT);
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    const SIMCTL: &str = r#"{
      "devices": {
        "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
          {"udid":"AAAA-1","name":"iPhone 16","state":"Booted","isAvailable":true,"extra":{"x":1}},
          {"udid":"AAAA-2","name":"iPhone 15","state":"Shutdown","isAvailable":true}
        ],
        "com.apple.CoreSimulator.SimRuntime.watchOS-11-0": [
          {"udid":"BBBB-1","name":"Watch","state":"Creating"},
          {"udid":"BBBB-2","name":"Gone","state":"Shutdown","isAvailable":false}
        ]
      },
      "unknownTop": 5
    }"#;

    #[test]
    fn simctl_json_gives_devices_with_runtime_and_state() {
        let list = parse_simctl(SIMCTL);
        let got: Vec<_> = list
            .iter()
            .map(|d| (d.name.as_str(), d.runtime.as_deref(), d.state))
            .collect();
        assert_eq!(
            got,
            [
                ("iPhone 16", Some("iOS 18.0"), SimState::Booted),
                ("iPhone 15", Some("iOS 18.0"), SimState::Shutdown),
                ("Watch", Some("watchOS 11.0"), SimState::Unknown),
            ]
        );
        assert!(parse_simctl("not json").is_empty());
        assert!(parse_simctl("{}").is_empty());
    }

    #[test]
    fn avd_and_adb_output_parse() {
        assert_eq!(
            parse_avds("INFO    | Storing crashdata\nPixel_8_API_35\n\nTablet\n"),
            ["Pixel_8_API_35", "Tablet"]
        );
        assert!(parse_avds("").is_empty());
        let adb = "List of devices attached\nemulator-5554\tdevice\nemulator-5556\toffline\nR58M\tdevice\n\n";
        assert_eq!(parse_adb_devices(adb), ["emulator-5554"]);
        assert!(parse_adb_devices("garbage").is_empty());
        assert_eq!(
            parse_avd_name("Pixel_8_API_35\nOK\n").as_deref(),
            Some("Pixel_8_API_35")
        );
        assert_eq!(parse_avd_name("error: closed"), None);
        assert_eq!(parse_avd_name(""), None);
    }

    fn files<'a>(present: &'a [PathBuf]) -> impl Fn(&Path) -> bool + 'a {
        move |p| present.iter().any(|f| f == p)
    }

    #[test]
    fn sdk_search_order_is_path_then_env_then_default() {
        let home = PathBuf::from("home").join("me");
        let tool = if cfg!(windows) {
            "emulator.exe"
        } else {
            "emulator"
        };
        let in_home = PathBuf::from("sdk-home").join("emulator").join(tool);
        let in_root = PathBuf::from("sdk-root").join("emulator").join(tool);
        let default_dir = if cfg!(target_os = "macos") {
            home.join("Library").join("Android").join("sdk")
        } else {
            home.join("Android").join("Sdk")
        };
        let in_default = default_dir.join("emulator").join(tool);
        let env = |k: &str| match k {
            "ANDROID_HOME" => Some("sdk-home".to_owned()),
            "ANDROID_SDK_ROOT" => Some("sdk-root".to_owned()),
            _ => None,
        };
        let on_path = |_: &str| Some(PathBuf::from("bin").join("emulator"));
        let none = |_: &str| None;
        let present = [in_home.clone(), in_root.clone(), in_default.clone()];
        let is_file = files(&present);
        let sdk = Sdk {
            find_program: &on_path,
            var: &env,
            is_file: &is_file,
            home: Some(home.clone()),
        };
        assert_eq!(
            sdk.find("emulator", "emulator"),
            Some(PathBuf::from("bin").join("emulator"))
        );
        let check =
            |find: &dyn Fn(&str) -> Option<PathBuf>, present: &[PathBuf], tool: &str, dir: &str| {
                let is_file = files(present);
                let sdk = Sdk {
                    find_program: find,
                    var: &env,
                    is_file: &is_file,
                    home: Some(home.clone()),
                };
                sdk.find(tool, dir)
            };
        assert_eq!(
            check(
                &none,
                &[in_home.clone(), in_root.clone(), in_default.clone()],
                "emulator",
                "emulator"
            ),
            Some(in_home)
        );
        assert_eq!(
            check(
                &none,
                &[in_root.clone(), in_default.clone()],
                "emulator",
                "emulator"
            ),
            Some(in_root)
        );
        if !cfg!(windows) {
            assert_eq!(
                check(
                    &none,
                    std::slice::from_ref(&in_default),
                    "emulator",
                    "emulator"
                ),
                Some(in_default)
            );
        }
        assert_eq!(check(&none, &[], "adb", "platform-tools"), None);
    }

    /// A fake tool set; records what ran.
    struct Fake {
        ran: RefCell<Vec<String>>,
    }
    impl Fake {
        fn run(&self, program: &str, args: &[&str], _t: Duration) -> Option<String> {
            self.ran
                .borrow_mut()
                .push(format!("{program} {}", args.join(" ")));
            match (program, args.first().copied()) {
                ("xcrun", Some("simctl")) if args.get(1) == Some(&"list") => Some(SIMCTL.into()),
                ("emu", Some("-list-avds")) => Some("Pixel_8_API_35\nTablet\n".into()),
                ("adb", Some("devices")) => {
                    Some("List of devices attached\nemulator-5554\tdevice\n".into())
                }
                ("adb", Some("-s")) => Some("Pixel_8_API_35\nOK\n".into()),
                _ => None,
            }
        }
    }

    fn fake_sdk<'a>(
        find: &'a dyn Fn(&str) -> Option<PathBuf>,
        var: &'a dyn Fn(&str) -> Option<String>,
        is_file: &'a dyn Fn(&Path) -> bool,
    ) -> Sdk<'a> {
        Sdk {
            find_program: find,
            var,
            is_file,
            home: None,
        }
    }

    #[test]
    fn list_marks_running_avds_and_reports_missing_tools() {
        let fake = Fake {
            ran: RefCell::new(Vec::new()),
        };
        let run = |p: &str, a: &[&str], t: Duration| fake.run(p, a, t);
        let find = |p: &str| match p {
            "emulator" => Some(PathBuf::from("emu")),
            "adb" => Some(PathBuf::from("adb")),
            _ => None,
        };
        let var = |_: &str| None;
        let nofile = |_: &Path| false;
        let list = list_all(true, &fake_sdk(&find, &var, &nofile), &run);
        assert!(list.problems.is_empty());
        assert_eq!(list.ios.as_ref().map(Vec::len), Some(3));
        let android = list.android.unwrap();
        assert_eq!(android[0].state, SimState::Booted);
        assert_eq!(android[0].serial.as_deref(), Some("emulator-5554"));
        assert_eq!(android[1].state, SimState::Shutdown);

        let none = |_: &str| None;
        let list = list_all(true, &fake_sdk(&none, &var, &nofile), &|_, _, _| None);
        assert_eq!(list.ios, None);
        assert_eq!(list.android, None);
        assert_eq!(
            list.problems,
            ["targets.sim.noXcode", "targets.sim.noAndroid"]
        );
        let list = list_all(false, &fake_sdk(&none, &var, &nofile), &|_, _, _| None);
        assert_eq!(list.problems, ["targets.sim.noAndroid"]);
    }

    #[test]
    fn adb_failure_leaves_the_state_unknown() {
        let run = |p: &str, a: &[&str], _t: Duration| match (p, a.first().copied()) {
            ("emu", Some("-list-avds")) => Some("Tablet\n".into()),
            _ => None,
        };
        let find = |p: &str| match p {
            "emulator" => Some(PathBuf::from("emu")),
            "adb" => Some(PathBuf::from("adb")),
            _ => None,
        };
        let var = |_: &str| None;
        let nofile = |_: &Path| false;
        let list = list_all(false, &fake_sdk(&find, &var, &nofile), &run);
        assert_eq!(list.android.unwrap()[0].state, SimState::Unknown);
    }

    fn avd(serial: Option<&str>) -> SimDevice {
        SimDevice {
            platform: SimPlatform::Android,
            id: "Pixel_8_API_35".into(),
            name: "Pixel_8_API_35".into(),
            runtime: None,
            state: SimState::Shutdown,
            serial: serial.map(str::to_owned),
        }
    }

    fn title(name: &str) -> String {
        format!("Logs: {name}")
    }

    #[test]
    fn android_commands_quote_paths_with_spaces() {
        let emu = PathBuf::from("/opt/my sdk/emulator/emulator");
        let adb = PathBuf::from("/opt/my sdk/platform-tools/adb");
        let l = sim_launch(&avd(None), Some(&emu), Some(&adb), Shell::Posix, &title).unwrap();
        assert_eq!(
            l.tab_command.as_deref(),
            Some("'/opt/my sdk/emulator/emulator' -avd Pixel_8_API_35")
        );
        assert_eq!(
            l.log_command,
            "'/opt/my sdk/platform-tools/adb' wait-for-device && '/opt/my sdk/platform-tools/adb' logcat -v color"
        );
        assert_eq!(l.title, "Logs: Pixel_8_API_35");
        let l = sim_launch(
            &avd(Some("emulator-5554")),
            Some(&emu),
            Some(&adb),
            Shell::Posix,
            &title,
        )
        .unwrap();
        assert!(
            l.log_command
                .contains("adb' -s emulator-5554 wait-for-device && ")
        );
        assert!(l.log_command.ends_with("-s emulator-5554 logcat -v color"));
        let l = sim_launch(
            &avd(None),
            Some(Path::new("C:\\Program Files\\e.exe")),
            Some(Path::new("a.exe")),
            Shell::PowerShell,
            &title,
        )
        .unwrap();
        assert_eq!(
            l.tab_command.as_deref(),
            Some("& 'C:\\Program Files\\e.exe' -avd Pixel_8_API_35")
        );
        assert!(l.log_command.contains("; & a.exe"));
        assert_eq!(
            sim_launch(&avd(None), None, None, Shell::Posix, &title)
                .unwrap_err()
                .code,
            "sim_tool_missing"
        );
    }

    #[test]
    fn ios_log_command_has_no_tab_command() {
        let d = parse_simctl(SIMCTL).remove(1);
        let l = sim_launch(&d, None, None, Shell::Posix, &title).unwrap();
        assert_eq!(l.tab_command, None);
        assert_eq!(
            l.log_command,
            "xcrun simctl spawn AAAA-2 log stream --style compact --level info"
        );
    }

    #[test]
    fn boot_matches_the_id_against_the_list() {
        let list = SimList {
            ios: Some(parse_simctl(SIMCTL)),
            android: None,
            problems: Vec::new(),
        };
        let r = |platform, id: &str| SimRef {
            platform,
            id: id.into(),
        };
        assert_eq!(
            find_device(&list, &r(SimPlatform::Ios, "AAAA-2"))
                .unwrap()
                .name,
            "iPhone 15"
        );
        assert_eq!(
            find_device(&list, &r(SimPlatform::Ios, "x; rm -rf /"))
                .unwrap_err()
                .code,
            "sim_not_found"
        );
        assert_eq!(
            find_device(&list, &r(SimPlatform::Android, "Tablet"))
                .unwrap_err()
                .code,
            "sim_tool_missing"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn ios_boot_runs_simctl_then_opens_simulator() {
        let fake = Fake {
            ran: RefCell::new(Vec::new()),
        };
        boot_ios("AAAA-2", &|p, a, t| fake.run(p, a, t));
        assert_eq!(
            *fake.ran.borrow(),
            ["xcrun simctl boot AAAA-2", "open -a Simulator"]
        );
    }
}
