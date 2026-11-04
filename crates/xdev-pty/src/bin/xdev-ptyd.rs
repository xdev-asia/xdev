//! The terminal service: `xdev-ptyd --dir <local dir>/ptyd [--ring-mb N]
//! [--prefix P]`; the prefix is for tests that must not meet a real service.
//! The app starts it detached; it ends 15 s after its last PTY and client.

// No console window of its own on Windows; its children get pseudo consoles.
#![cfg_attr(windows, windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::ExitCode;

use xdev_ipc::{IpcError, endpoint};
use xdev_pty::proto::{PROTOCOL, RING_DEFAULT, RING_MAX};
use xdev_pty::service::{Config, start};

fn main() -> ExitCode {
    let mut dir: Option<PathBuf> = None;
    let mut ring = RING_DEFAULT;
    let mut prefix: Option<String> = None;
    let mut args = std::env::args_os().skip(1);
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--dir") => dir = args.next().map(PathBuf::from),
            Some("--prefix") => prefix = args.next().and_then(|p| p.into_string().ok()),
            Some("--ring-mb") => {
                let mb: Option<usize> = args.next().and_then(|v| v.to_str()?.parse().ok());
                ring = mb.map_or(RING_DEFAULT, |mb| (mb * 1024 * 1024).clamp(1, RING_MAX));
            }
            _ => {
                eprintln!("usage: xdev-ptyd --dir <dir> [--ring-mb <1..16>] [--prefix <p>]");
                return ExitCode::from(2);
            }
        }
    }
    let Some(dir) = dir else {
        eprintln!("xdev-ptyd: --dir is required");
        return ExitCode::from(2);
    };
    let mut cfg = Config::new(dir, ring);
    if let Some(prefix) = prefix {
        cfg.endpoint = endpoint(&cfg.dir, &prefix, PROTOCOL);
    }
    match start(cfg) {
        Ok(service) => {
            service.wait();
            ExitCode::SUCCESS
        }
        // Another service already answers: nothing to do.
        Err(IpcError::InUse) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("xdev-ptyd: {e}");
            ExitCode::FAILURE
        }
    }
}
