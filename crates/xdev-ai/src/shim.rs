//! Argument vectors for CLIs that npm installs as `.cmd` / `.bat` shims.
//!
//! A batch file runs under `cmd.exe`, which re-parses the whole line: `&`,
//! `|` and friends split commands, and `%`/`!` expand even inside quotes.
//! So batch launches go through one quoted `/c` line and refuse the
//! characters quoting cannot make safe.

use std::ffi::OsString;
use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum ShimError {
    #[error("argument not allowed for a batch file: {0}")]
    UnsafeArg(String),
}

impl ShimError {
    /// Stable code the UI and CLI translate.
    pub fn code(&self) -> &'static str {
        match self {
            ShimError::UnsafeArg(_) => "bad_arg",
        }
    }
}

pub fn is_batch(program: &Path) -> bool {
    program
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
}

/// `[program, args…]`, or for a batch file `cmd.exe /d /s /c "<line>"`.
pub fn argv(program: &Path, args: &[String]) -> Result<Vec<OsString>, ShimError> {
    if !is_batch(program) {
        let mut v = vec![program.as_os_str().to_owned()];
        v.extend(args.iter().map(OsString::from));
        return Ok(v);
    }
    if let Some(bad) = args
        .iter()
        .find(|a| a.contains(['"', '%', '!', '\r', '\n']))
    {
        return Err(ShimError::UnsafeArg(bad.clone()));
    }
    // The program is always quoted: a path with spaces is the common case.
    let mut line = format!("\"{}\"", program.to_string_lossy());
    for arg in args {
        line.push(' ');
        line.push_str(&quote(arg));
    }
    // `/s` strips exactly the outer pair of quotes, leaving the line as built.
    Ok(["cmd.exe", "/d", "/s", "/c"]
        .map(OsString::from)
        .into_iter()
        .chain([OsString::from(format!("\"{line}\""))])
        .collect())
}

fn quote(arg: &str) -> String {
    if arg.is_empty() || arg.contains([' ', '\t', '&', '|', '<', '>', '^', '(', ')']) {
        format!("\"{arg}\"")
    } else {
        arg.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exe_passes_through() {
        let v = argv(
            Path::new(r"C:\bin\codex.exe"),
            &["--model".into(), "o3".into()],
        )
        .unwrap();
        assert_eq!(
            v,
            [r"C:\bin\codex.exe", "--model", "o3"].map(OsString::from)
        );
    }

    #[test]
    fn cmd_goes_through_cmd_exe_with_quoting() {
        let v = argv(
            Path::new(r"C:\npm\claude.cmd"),
            &["--model".into(), "a b".into(), "x&y".into()],
        )
        .unwrap();
        assert_eq!(v[..4], ["cmd.exe", "/d", "/s", "/c"].map(OsString::from));
        assert_eq!(
            v[4],
            OsString::from(r#"""C:\npm\claude.cmd" --model "a b" "x&y"""#)
        );
    }

    #[test]
    fn batch_refuses_quote_percent_bang_newline() {
        for bad in ["a\"b", "%PATH%", "!x!", "a\nb"] {
            let err = argv(Path::new("x.bat"), &[bad.into()]).unwrap_err();
            assert_eq!(err.code(), "bad_arg");
        }
    }

    #[test]
    fn is_batch_ignores_case() {
        assert!(
            is_batch(Path::new("A.CMD"))
                && is_batch(Path::new("b.Bat"))
                && !is_batch(Path::new("c.exe"))
        );
    }
}
