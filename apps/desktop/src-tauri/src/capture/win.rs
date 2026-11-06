//! Windows: the Snipping Tool overlay (`ms-screenclip:`) puts the region on
//! the clipboard. The clipboard is polled until its image changes.

#![cfg_attr(not(any(windows, test)), allow(dead_code))]

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::commands::CmdError;

use super::err;

pub(crate) const POLL: Duration = Duration::from_millis(250);
pub(crate) const LIMIT: Duration = Duration::from_secs(120);

type Image = (u32, u32, Vec<u8>);

/// The clipboard image as the poll sees it; arboard in the app, a fake in tests.
pub(crate) trait Clipboard {
    fn image(&mut self) -> Option<Image>;
}

/// The blake3 of the RGBA bytes; no image hashes as empty input.
pub(crate) fn hash(image: Option<&Image>) -> blake3::Hash {
    blake3::hash(image.map_or(&[][..], |(_, _, rgba)| rgba))
}

/// Polls every `poll` until the image differs from `before`. `None` when
/// `cancel` is set, `capture_timeout` after `limit`.
pub(crate) fn wait_for_change(
    clip: &mut dyn Clipboard,
    before: blake3::Hash,
    cancel: &AtomicBool,
    sleep: &mut dyn FnMut(Duration),
    poll: Duration,
    limit: Duration,
) -> Result<Option<Image>, CmdError> {
    let rounds = limit.as_millis() / poll.as_millis().max(1);
    for _ in 0..rounds {
        sleep(poll);
        if cancel.load(Ordering::SeqCst) {
            return Ok(None);
        }
        if let Some(image) = clip.image()
            && hash(Some(&image)) != before
        {
            return Ok(Some(image));
        }
    }
    Err(err("capture_timeout", None))
}

#[cfg(windows)]
struct Arboard(Option<arboard::Clipboard>);

#[cfg(windows)]
impl Clipboard for Arboard {
    fn image(&mut self) -> Option<Image> {
        if self.0.is_none() {
            self.0 = arboard::Clipboard::new().ok();
        }
        let img = self.0.as_mut()?.get_image().ok()?;
        Some((
            u32::try_from(img.width).ok()?,
            u32::try_from(img.height).ok()?,
            img.bytes.into_owned(),
        ))
    }
}

#[cfg(windows)]
pub(crate) fn grab(cancel: &AtomicBool) -> Result<Option<super::Shot>, CmdError> {
    use tauri_plugin_opener::open_url;

    let mut clip = Arboard(None);
    let before = hash(clip.image().as_ref());
    open_url("ms-screenclip:", None::<&str>).map_err(super::io_error)?;
    let image = wait_for_change(
        &mut clip,
        before,
        cancel,
        &mut std::thread::sleep,
        POLL,
        LIMIT,
    )?;
    Ok(image.map(|(w, h, rgba)| super::Shot::Rgba(w, h, rgba)))
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    /// Returns each image in turn, then the last one forever.
    struct Fake(Vec<Option<Image>>);

    impl Clipboard for Fake {
        fn image(&mut self) -> Option<Image> {
            if self.0.len() > 1 {
                self.0.remove(0)
            } else {
                self.0[0].clone()
            }
        }
    }

    fn img(byte: u8) -> Option<Image> {
        Some((1, 1, vec![byte; 4]))
    }

    fn run(
        fake: &mut Fake,
        before: Option<Image>,
        cancel: &AtomicBool,
    ) -> (Result<Option<Image>, CmdError>, u32) {
        let slept = Cell::new(0);
        let r = wait_for_change(
            fake,
            hash(before.as_ref()),
            cancel,
            &mut |d| {
                assert_eq!(d, POLL);
                slept.set(slept.get() + 1);
            },
            POLL,
            LIMIT,
        );
        (r, slept.get())
    }

    #[test]
    fn unchanged_keeps_waiting_and_a_change_returns() {
        let mut fake = Fake(vec![img(1), None, img(1), img(2)]);
        let (r, rounds) = run(&mut fake, img(1), &AtomicBool::new(false));
        assert_eq!(r.unwrap(), img(2));
        assert_eq!(rounds, 4);
    }

    #[test]
    fn an_image_where_there_was_none_counts() {
        let mut fake = Fake(vec![img(3)]);
        let (r, rounds) = run(&mut fake, None, &AtomicBool::new(false));
        assert_eq!(r.unwrap(), img(3));
        assert_eq!(rounds, 1);
    }

    #[test]
    fn the_limit_is_a_timeout() {
        let mut fake = Fake(vec![img(1)]);
        let (r, rounds) = run(&mut fake, img(1), &AtomicBool::new(false));
        assert_eq!(r.unwrap_err().code, "capture_timeout");
        assert_eq!(rounds, 480);
    }

    #[test]
    fn cancel_stops() {
        let mut fake = Fake(vec![img(1)]);
        let (r, rounds) = run(&mut fake, img(1), &AtomicBool::new(true));
        assert_eq!(r.unwrap(), None);
        assert_eq!(rounds, 1);
    }
}
