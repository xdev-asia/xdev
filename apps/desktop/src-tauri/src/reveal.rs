//! Shows a folder or an item in the OS file manager. Does not wait for the
//! file manager to close.

use std::ffi::OsString;
use std::io;
use std::path::Path;
use std::process::Command;

/// Opens `path` in the file manager. With `select`, opens the folder that
/// holds it with the item selected where the OS can (Windows, macOS); Linux
/// opens the folder.
pub(crate) fn reveal(path: &Path, select: bool) -> io::Result<()> {
    let (program, args) = launch(path, select);
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // explorer reads `/select,"…"` itself; Rust's own quoting breaks it.
        for arg in &args {
            command.raw_arg(arg);
        }
    }
    #[cfg(not(windows))]
    command.args(&args);
    let mut child = command.spawn()?;
    // Reaped off the command thread; explorer's exit code means nothing.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// The program and its arguments. On Windows the arguments are written raw,
/// so they carry their own quotes; a Windows path cannot hold a `"`.
#[cfg(windows)]
fn launch(path: &Path, select: bool) -> (&'static str, Vec<OsString>) {
    // explorer wants backslashes; the UI sends `E:/…`.
    let path = path.to_string_lossy().replace('/', "\\");
    let arg = if select {
        format!("/select,\"{path}\"")
    } else {
        format!("\"{path}\"")
    };
    ("explorer.exe", vec![arg.into()])
}

#[cfg(target_os = "macos")]
fn launch(path: &Path, select: bool) -> (&'static str, Vec<OsString>) {
    let mut args = Vec::new();
    if select {
        args.push("-R".into());
    }
    args.push(path.into());
    ("open", args)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn launch(path: &Path, select: bool) -> (&'static str, Vec<OsString>) {
    let shown = match path.parent() {
        Some(parent) if select && !parent.as_os_str().is_empty() => parent,
        _ => path,
    };
    ("xdg-open", vec![shown.into()])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn explorer_selects_the_item_with_backslashes() {
        let path = Path::new("E:/Codes/a b/src\\m.rs");
        assert_eq!(
            launch(path, true),
            (
                "explorer.exe",
                vec![OsString::from(r#"/select,"E:\Codes\a b\src\m.rs""#)]
            )
        );
        assert_eq!(
            launch(Path::new("E:/Codes/a b"), false),
            ("explorer.exe", vec![OsString::from(r#""E:\Codes\a b""#)])
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn open_reveals_with_dash_r() {
        let path = Path::new("/Users/me/a b/m.rs");
        assert_eq!(launch(path, true), ("open", vec!["-R".into(), path.into()]));
        assert_eq!(launch(path, false), ("open", vec![path.into()]));
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn xdg_open_shows_the_folder() {
        let path = Path::new("/home/me/a b/m.rs");
        assert_eq!(
            launch(path, true),
            ("xdg-open", vec![Path::new("/home/me/a b").into()])
        );
        assert_eq!(launch(path, false), ("xdg-open", vec![path.into()]));
    }
}
