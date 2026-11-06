//! Linux: the desktop portal's screenshot call first; without a portal, the
//! first region tool found on `PATH`.

#![cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::commands::CmdError;

use super::err;

/// The path a portal `file://` URI names, percent escapes decoded.
pub(crate) fn uri_path(uri: &str) -> Option<PathBuf> {
    let url = url::Url::parse(uri).ok()?;
    if url.scheme() != "file" {
        return None;
    }
    url.to_file_path().ok()
}

/// The portal's file may be deleted only when it sits in a temp folder.
pub(crate) fn deletable(path: &Path, runtime_dir: Option<&Path>) -> bool {
    path.starts_with("/tmp") || runtime_dir.is_some_and(|d| d.is_absolute() && path.starts_with(d))
}

/// Whether a portal error says the portal is not there (service or
/// interface unknown), so a CLI tool is worth trying.
pub(crate) fn portal_missing(error: &str) -> bool {
    [
        "ServiceUnknown",
        "UnknownInterface",
        "UnknownMethod",
        "NameHasNoOwner",
        "org.freedesktop.portal.Screenshot",
    ]
    .iter()
    .any(|name| error.contains(name))
}

/// A region tool, with the files it runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Tool {
    Grim { grim: PathBuf, slurp: PathBuf },
    Spectacle(PathBuf),
    GnomeScreenshot(PathBuf),
    Maim(PathBuf),
    Scrot(PathBuf),
}

/// The first tool found, in the order grim (with slurp), spectacle,
/// gnome-screenshot, maim, scrot.
pub(crate) fn pick_tool(find: &dyn Fn(&str) -> Option<PathBuf>) -> Option<Tool> {
    if let (Some(grim), Some(slurp)) = (find("grim"), find("slurp")) {
        return Some(Tool::Grim { grim, slurp });
    }
    find("spectacle")
        .map(Tool::Spectacle)
        .or_else(|| find("gnome-screenshot").map(Tool::GnomeScreenshot))
        .or_else(|| find("maim").map(Tool::Maim))
        .or_else(|| find("scrot").map(Tool::Scrot))
}

/// The program and arguments that write the region to `out`. For grim, the
/// region `slurp` printed.
pub(crate) fn command(tool: &Tool, out: &Path, geometry: &str) -> (PathBuf, Vec<OsString>) {
    let args = |list: &[&str]| -> Vec<OsString> {
        let mut v: Vec<OsString> = list.iter().map(OsString::from).collect();
        v.push(out.as_os_str().to_owned());
        v
    };
    match tool {
        Tool::Grim { grim, .. } => (grim.clone(), args(&["-g", geometry])),
        Tool::Spectacle(p) => (p.clone(), args(&["-r", "-b", "-n", "-o"])),
        Tool::GnomeScreenshot(p) => (p.clone(), args(&["-a", "-f"])),
        Tool::Maim(p) => (p.clone(), args(&["-s"])),
        Tool::Scrot(p) => (p.clone(), args(&["-s"])),
    }
}

/// What slurp printed: the region, or `None` for a cancel (exit 1 or no output).
pub(crate) fn slurp_region(code: Option<i32>, stdout: &str) -> Result<Option<String>, CmdError> {
    let region = stdout.trim();
    match code {
        Some(0) if !region.is_empty() => Ok(Some(region.to_owned())),
        Some(0) | Some(1) => Ok(None),
        _ => Err(err("io", "slurp failed".to_owned())),
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn grab(tmp: &Path) -> Result<Option<super::Shot>, CmdError> {
    match portal() {
        Ok(png) => Ok(png.map(super::Shot::Png)),
        Err(Portal::Missing) => {
            cli(&|p| xdev_agent::find_program(p), tmp).map(|o| o.map(super::Shot::Png))
        }
        Err(Portal::Failed(e)) => Err(e),
    }
}

#[cfg(target_os = "linux")]
enum Portal {
    Missing,
    Failed(CmdError),
}

#[cfg(target_os = "linux")]
fn portal() -> Result<Option<Vec<u8>>, Portal> {
    use ashpd::desktop::ResponseError;
    use ashpd::desktop::screenshot::Screenshot;

    // zbus runs its own reactor, so any executor can wait on it.
    let response = tauri::async_runtime::block_on(async {
        Screenshot::request()
            .interactive(true)
            .modal(true)
            .send()
            .await?
            .response()
    });
    let shot = match response {
        Ok(shot) => shot,
        Err(ashpd::Error::Response(ResponseError::Cancelled)) => return Ok(None),
        Err(ashpd::Error::PortalNotFound(_)) => return Err(Portal::Missing),
        Err(e) if portal_missing(&e.to_string()) => return Err(Portal::Missing),
        Err(e) => return Err(Portal::Failed(super::io_error(e))),
    };
    let path = uri_path(shot.uri().as_str())
        .ok_or_else(|| Portal::Failed(super::io_error("the portal sent no file")))?;
    let bytes = std::fs::read(&path).map_err(|e| Portal::Failed(super::io_error(e)))?;
    let runtime = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from);
    if deletable(&path, runtime.as_deref()) {
        let _ = std::fs::remove_file(&path);
    }
    Ok(Some(bytes))
}

#[cfg(target_os = "linux")]
fn cli(find: &dyn Fn(&str) -> Option<PathBuf>, tmp: &Path) -> Result<Option<Vec<u8>>, CmdError> {
    use std::process::Command;

    let tool = pick_tool(find).ok_or_else(|| err("capture_no_tool", None))?;
    let geometry = match &tool {
        Tool::Grim { slurp, .. } => {
            let out = Command::new(slurp).output().map_err(super::io_error)?;
            match slurp_region(out.status.code(), &String::from_utf8_lossy(&out.stdout))? {
                Some(region) => region,
                None => return Ok(None),
            }
        }
        _ => String::new(),
    };
    let (program, args) = command(&tool, tmp, &geometry);
    let out = Command::new(program).args(args).output();
    let png = super::take_file(tmp);
    let out = out.map_err(super::io_error)?;
    if png.is_some() {
        return Ok(png);
    }
    // Every tool exits 0 or 1 when the person backs out of the selection.
    match out.status.code() {
        Some(0) | Some(1) => Ok(None),
        _ => Err(err(
            "io",
            String::from_utf8_lossy(&out.stderr).trim().to_owned(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finder(have: &'static [&'static str]) -> impl Fn(&str) -> Option<PathBuf> {
        move |name| {
            have.contains(&name)
                .then(|| PathBuf::from(format!("/usr/bin/{name}")))
        }
    }

    fn bin(name: &str) -> PathBuf {
        PathBuf::from(format!("/usr/bin/{name}"))
    }

    #[test]
    fn tools_are_tried_in_order() {
        let all = &[
            "grim",
            "slurp",
            "spectacle",
            "gnome-screenshot",
            "maim",
            "scrot",
        ];
        assert_eq!(
            pick_tool(&finder(all)),
            Some(Tool::Grim {
                grim: bin("grim"),
                slurp: bin("slurp")
            })
        );
        // grim needs slurp.
        assert_eq!(
            pick_tool(&finder(&["grim", "spectacle", "maim"])),
            Some(Tool::Spectacle(bin("spectacle")))
        );
        assert_eq!(
            pick_tool(&finder(&["scrot", "gnome-screenshot", "maim"])),
            Some(Tool::GnomeScreenshot(bin("gnome-screenshot")))
        );
        assert_eq!(
            pick_tool(&finder(&["scrot", "maim"])),
            Some(Tool::Maim(bin("maim")))
        );
        assert_eq!(
            pick_tool(&finder(&["scrot", "slurp"])),
            Some(Tool::Scrot(bin("scrot")))
        );
        assert_eq!(pick_tool(&finder(&[])), None);
    }

    #[test]
    fn commands_write_to_the_temp_file() {
        let out = Path::new("/tmp/x.png");
        let args = |tool: Tool, geom: &str| -> Vec<String> {
            command(&tool, out, geom)
                .1
                .iter()
                .map(|a| a.to_string_lossy().into_owned())
                .collect()
        };
        let grim = Tool::Grim {
            grim: bin("grim"),
            slurp: bin("slurp"),
        };
        assert_eq!(args(grim, "1,2 3x4"), ["-g", "1,2 3x4", "/tmp/x.png"]);
        assert_eq!(
            args(Tool::Spectacle(bin("spectacle")), ""),
            ["-r", "-b", "-n", "-o", "/tmp/x.png"]
        );
        assert_eq!(
            args(Tool::GnomeScreenshot(bin("g")), ""),
            ["-a", "-f", "/tmp/x.png"]
        );
        assert_eq!(args(Tool::Maim(bin("maim")), ""), ["-s", "/tmp/x.png"]);
        assert_eq!(args(Tool::Scrot(bin("scrot")), ""), ["-s", "/tmp/x.png"]);
    }

    #[test]
    fn slurp_cancel_is_exit_1_or_no_output() {
        assert_eq!(
            slurp_region(Some(0), "1,2 3x4\n").unwrap(),
            Some("1,2 3x4".into())
        );
        assert_eq!(slurp_region(Some(0), "\n").unwrap(), None);
        assert_eq!(slurp_region(Some(1), "").unwrap(), None);
        assert_eq!(slurp_region(Some(2), "").unwrap_err().code, "io");
    }

    #[cfg(unix)]
    #[test]
    fn portal_uris_decode_percent_escapes() {
        assert_eq!(
            uri_path("file:///tmp/Screenshot%20from%202026.png"),
            Some(PathBuf::from("/tmp/Screenshot from 2026.png"))
        );
        assert_eq!(
            uri_path("file:///home/a/%C3%A1nh.png"),
            Some(PathBuf::from("/home/a/ánh.png"))
        );
        assert_eq!(
            uri_path("file:///tmp/a/../b.png"),
            Some(PathBuf::from("/tmp/b.png"))
        );
        assert_eq!(uri_path("https://example.org/a.png"), None);
        assert_eq!(uri_path("not a uri"), None);
    }

    #[test]
    fn only_temp_files_are_deleted() {
        let run = Some(Path::new("/run/user/1000"));
        assert!(deletable(Path::new("/tmp/s.png"), run));
        assert!(deletable(Path::new("/run/user/1000/s.png"), run));
        assert!(!deletable(Path::new("/home/a/Pictures/s.png"), run));
        assert!(!deletable(Path::new("/tmpfoo/s.png"), run));
        assert!(!deletable(Path::new("/run/user/1000/s.png"), None));
        assert!(!deletable(Path::new("/x/s.png"), Some(Path::new(""))));
    }

    #[test]
    fn a_missing_portal_is_recognized() {
        assert!(portal_missing(
            "org.freedesktop.DBus.Error.ServiceUnknown: The name is not activatable"
        ));
        assert!(portal_missing(
            "No such interface “org.freedesktop.portal.Screenshot”"
        ));
        assert!(!portal_missing("org.freedesktop.DBus.Error.AccessDenied"));
    }
}
