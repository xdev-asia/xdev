//! macOS: `screencapture -i` lets the person pick a region and writes a PNG.

use crate::commands::CmdError;

use super::err;

/// What a finished `screencapture` run means: the PNG, `None` for a cancel,
/// or an error read from stderr.
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
pub(crate) fn outcome(
    success: bool,
    stderr: &str,
    png: Option<Vec<u8>>,
) -> Result<Option<Vec<u8>>, CmdError> {
    if success {
        return Ok(png);
    }
    let lower = stderr.to_lowercase();
    if lower.contains("not authorized") || lower.contains("permission") {
        return Err(err("capture_denied", stderr.trim().to_owned()));
    }
    Err(err("io", stderr.trim().to_owned()))
}

#[cfg(target_os = "macos")]
pub(crate) fn grab(tmp: &std::path::Path) -> Result<Option<super::Shot>, CmdError> {
    let out = std::process::Command::new("/usr/sbin/screencapture")
        .args(["-i", "-x", "-t", "png"])
        .arg(tmp)
        .output()
        .map_err(super::io_error);
    let png = super::take_file(tmp);
    let out = out?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    Ok(outcome(out.status.success(), &stderr, png)?.map(super::Shot::Png))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_zero_without_a_file_is_a_cancel() {
        assert_eq!(outcome(true, "", None).unwrap(), None);
        assert_eq!(outcome(true, "", Some(vec![1])).unwrap(), Some(vec![1]));
    }

    #[test]
    fn stderr_maps_to_a_code() {
        let code = |s: &str| outcome(false, s, None).unwrap_err().code;
        assert_eq!(
            code("screencapture: Not Authorized to capture"),
            "capture_denied"
        );
        assert_eq!(
            code("could not create image: PERMISSION denied"),
            "capture_denied"
        );
        assert_eq!(code("could not create image from display"), "io");
        assert_eq!(code(""), "io");
    }
}
