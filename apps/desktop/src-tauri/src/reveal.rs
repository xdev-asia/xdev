//! Shows a folder, or a file in its folder, in the system file manager.

use std::io;
use std::path::Path;
use std::process::Command;

/// Opens `path` in the file manager. With `select`, opens the folder that
/// holds `path` with `path` selected where the system can (Windows, macOS);
/// elsewhere it opens that folder.
pub fn reveal(path: &Path, select: bool) -> io::Result<()> {
    let mut child = command(path, select).spawn()?;
    // Reaped off the command thread; the file manager's exit code means nothing.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(windows)]
fn command(path: &Path, select: bool) -> Command {
    use std::os::windows::process::CommandExt;
    let mut cmd = Command::new("explorer.exe");
    if select {
        // explorer reads `/select,"<path>"` as one argument; std quoting would
        // wrap the whole switch. Windows paths cannot hold `"`.
        cmd.raw_arg(format!("/select,\"{}\"", path.display()));
    } else {
        cmd.arg(path);
    }
    cmd
}

#[cfg(target_os = "macos")]
fn command(path: &Path, select: bool) -> Command {
    let mut cmd = Command::new("open");
    if select {
        cmd.arg("-R");
    }
    cmd.arg(path);
    cmd
}

#[cfg(all(unix, not(target_os = "macos")))]
fn command(path: &Path, select: bool) -> Command {
    let mut cmd = Command::new("xdg-open");
    let folder = if select { path.parent() } else { None };
    cmd.arg(folder.unwrap_or(path));
    cmd
}
