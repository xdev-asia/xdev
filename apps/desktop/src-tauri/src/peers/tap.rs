//! A copy of each PTY's output for paired computers that watch it.
//!
//! `ptyd` wraps every sink it hands out with `tee`, so a tab's bytes reach
//! the tab and, while someone watches, the watchers. Each tap keeps the last
//! `RING` bytes so a watcher that reconnects resumes from its `seq`. Bytes
//! never leave this module except through a subscriber.

use std::collections::{HashMap, VecDeque};
use std::sync::{LazyLock, Mutex, MutexGuard, PoisonError};

use xdev_pty::client::Sink;

/// What a watcher can catch up on after a drop.
pub(crate) const RING: usize = 256 * 1024;

/// One event for a watcher. Called with the tap locked: keep it short and
/// never call back into this module.
pub(crate) enum Frame<'a> {
    /// `seq` is the offset of `bytes[0]` in everything the tab printed.
    Output {
        seq: u64,
        bytes: &'a [u8],
    },
    Exit,
}

pub(crate) type Watcher = Box<dyn FnMut(Frame<'_>) + Send>;

#[derive(Default)]
struct Tap {
    /// Bumped by each `tee`; only the newest sink's exit ends the tap.
    generation: u64,
    /// The offset just past the last byte seen.
    end: u64,
    ring: VecDeque<u8>,
    watchers: Vec<(u64, Watcher)>,
}

impl Tap {
    fn start(&self) -> u64 {
        self.end - self.ring.len() as u64
    }

    fn push(&mut self, bytes: &[u8]) {
        let seq = self.end;
        self.end += bytes.len() as u64;
        if bytes.len() >= RING {
            self.ring.clear();
            self.ring.extend(&bytes[bytes.len() - RING..]);
        } else {
            let over = (self.ring.len() + bytes.len()).saturating_sub(RING);
            self.ring.drain(..over);
            self.ring.extend(bytes);
        }
        for (_, w) in &mut self.watchers {
            w(Frame::Output { seq, bytes });
        }
    }
}

#[derive(Default)]
struct Taps {
    next: u64,
    by_id: HashMap<String, Tap>,
}

static TAPS: LazyLock<Mutex<Taps>> = LazyLock::new(Mutex::default);

fn taps() -> MutexGuard<'static, Taps> {
    TAPS.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Wraps `sink` so tab `id`'s output also reaches its watchers.
pub(crate) fn tee(id: &str, sink: Sink) -> Sink {
    let generation = {
        let mut t = taps();
        t.next += 1;
        let generation = t.next;
        t.by_id.entry(id.to_owned()).or_default().generation = generation;
        generation
    };
    let Sink {
        mut on_output,
        on_exit,
    } = sink;
    let out_id = id.to_owned();
    let exit_id = id.to_owned();
    Sink {
        on_output: Box::new(move |bytes: Vec<u8>| {
            if let Some(tap) = taps().by_id.get_mut(&out_id) {
                tap.push(&bytes);
            }
            on_output(bytes);
        }),
        on_exit: Box::new(move |code| {
            end(&exit_id, Some(generation));
            on_exit(code);
        }),
    }
}

/// Drops tab `id`'s tap and tells its watchers. `generation` guards against a
/// stale sink ending a newer one; `None` ends it regardless.
fn end(id: &str, generation: Option<u64>) {
    let mut t = taps();
    let current = t.by_id.get(id).map(|tap| tap.generation);
    if current.is_none() || generation.is_some_and(|g| Some(g) != current) {
        return;
    }
    if let Some(mut tap) = t.by_id.remove(id) {
        for (_, w) in &mut tap.watchers {
            w(Frame::Exit);
        }
    }
}

/// Watches tab `id` from `from_seq`: what the ring still holds is replayed
/// first. Returns the watcher id and the seq the replay starts at; `None`
/// when the tab has no tap (not running).
pub(crate) fn subscribe(id: &str, from_seq: u64, mut watcher: Watcher) -> Option<(u64, u64)> {
    let mut t = taps();
    t.next += 1;
    let wid = t.next;
    let tap = t.by_id.get_mut(id)?;
    let start = from_seq.clamp(tap.start(), tap.end);
    let skip = (start - tap.start()) as usize;
    let (a, b) = tap.ring.as_slices();
    let replay: Vec<u8> = a.iter().chain(b).skip(skip).copied().collect();
    if !replay.is_empty() {
        watcher(Frame::Output {
            seq: start,
            bytes: &replay,
        });
    }
    tap.watchers.push((wid, watcher));
    Some((wid, start))
}

/// Stops watcher `wid` of tab `id`; nothing when it is already gone.
pub(crate) fn unsubscribe(id: &str, wid: u64) {
    if let Some(tap) = taps().by_id.get_mut(id) {
        tap.watchers.retain(|(w, _)| *w != wid);
    }
}

#[cfg(test)]
pub(crate) fn feed(id: &str, bytes: &[u8]) {
    if let Some(tap) = taps().by_id.get_mut(id) {
        tap.push(bytes);
    }
}

/// A tap with no PTY behind it, for tests.
#[cfg(test)]
pub(crate) fn open_for_test(id: &str) {
    let mut t = taps();
    t.next += 1;
    let generation = t.next;
    t.by_id.entry(id.to_owned()).or_default().generation = generation;
}

#[cfg(test)]
pub(crate) fn close_for_test(id: &str) {
    end(id, None);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    type Seen = Arc<Mutex<Vec<(u64, Vec<u8>)>>>;

    fn recorder(seen: &Seen, exited: &Arc<Mutex<bool>>) -> Watcher {
        let seen = seen.clone();
        let exited = exited.clone();
        Box::new(move |f| match f {
            Frame::Output { seq, bytes } => seen.lock().unwrap().push((seq, bytes.to_vec())),
            Frame::Exit => *exited.lock().unwrap() = true,
        })
    }

    #[test]
    fn tee_copies_output_and_replays_from_seq() {
        let got: Arc<Mutex<Vec<u8>>> = Arc::default();
        let g = got.clone();
        let sink = Sink {
            on_output: Box::new(move |b| g.lock().unwrap().extend(b)),
            on_exit: Box::new(|_| {}),
        };
        let mut sink = tee("tap-tee", sink);
        (sink.on_output)(b"hello ".to_vec());
        (sink.on_output)(b"world".to_vec());
        assert_eq!(&*got.lock().unwrap(), b"hello world");

        let seen: Seen = Arc::default();
        let exited = Arc::new(Mutex::new(false));
        let (wid, start) = subscribe("tap-tee", 6, recorder(&seen, &exited)).unwrap();
        assert_eq!(start, 6);
        (sink.on_output)(b"!".to_vec());
        assert_eq!(
            *seen.lock().unwrap(),
            vec![(6, b"world".to_vec()), (11, b"!".to_vec())]
        );
        unsubscribe("tap-tee", wid);
        (sink.on_output)(b"?".to_vec());
        assert_eq!(seen.lock().unwrap().len(), 2);

        let exited2 = Arc::new(Mutex::new(false));
        subscribe("tap-tee", 0, recorder(&Seen::default(), &exited2)).unwrap();
        (sink.on_exit)(Some(0));
        assert!(*exited2.lock().unwrap());
        assert!(subscribe("tap-tee", 0, recorder(&seen, &exited)).is_none());
    }

    #[test]
    fn a_stale_sink_does_not_end_a_newer_one() {
        let quiet = || Sink {
            on_output: Box::new(|_| {}),
            on_exit: Box::new(|_| {}),
        };
        let old = tee("tap-gen", quiet());
        let _new = tee("tap-gen", quiet());
        (old.on_exit)(None);
        assert!(subscribe("tap-gen", 0, Box::new(|_| {})).is_some());
        close_for_test("tap-gen");
    }

    #[test]
    fn ring_keeps_the_tail() {
        open_for_test("tap-ring");
        feed("tap-ring", &vec![b'a'; RING]);
        feed("tap-ring", b"bc");
        let seen: Seen = Arc::default();
        let exited = Arc::new(Mutex::new(false));
        let (_, start) = subscribe("tap-ring", 0, recorder(&seen, &exited)).unwrap();
        assert_eq!(start, 2, "the first two bytes fell out of the ring");
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].1.len(), RING);
        assert!(seen[0].1.ends_with(b"abc"));
        close_for_test("tap-ring");
    }
}
