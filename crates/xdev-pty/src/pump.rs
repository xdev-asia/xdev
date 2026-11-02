//! Moves PTY output to the UI: small reads are batched for up to 16 ms, and
//! reading stops while more than `WINDOW` bytes wait for the UI's ack.

use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

pub const READ_CHUNK: usize = 8 * 1024;
pub const COALESCE: Duration = Duration::from_millis(16);
pub const WINDOW: usize = 4 * 1024 * 1024;

/// A batch goes out early once it reaches this size.
const MAX_BATCH: usize = READ_CHUNK * 8;
/// How often a waiting pump looks at its stop flag.
const POLL: Duration = Duration::from_millis(50);

/// Bytes sent to the UI that it has not yet acked.
#[derive(Debug, Default)]
pub struct Flow {
    unacked: Mutex<usize>,
    below: Condvar,
}

impl Flow {
    pub(crate) fn sent(&self, n: usize) {
        *self.lock() += n;
    }

    pub fn ack(&self, n: usize) {
        let mut unacked = self.lock();
        *unacked = unacked.saturating_sub(n);
        self.below.notify_all();
    }

    /// Blocks while the UI is a full window behind, or until `stop` is set.
    pub(crate) fn wait_below_window(&self, stop: &AtomicBool) {
        let mut unacked = self.lock();
        while *unacked >= WINDOW && !stop.load(Ordering::SeqCst) {
            unacked = self
                .below
                .wait_timeout(unacked, POLL)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }

    fn lock(&self) -> MutexGuard<'_, usize> {
        self.unacked.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Runs until EOF or `stop`. The reads happen on their own thread, so a
/// reader that blocks cannot hold back bytes already read.
pub(crate) fn pump(
    reader: impl Read + Send + 'static,
    flow: Arc<Flow>,
    stop: Arc<AtomicBool>,
    mut sink: impl FnMut(Vec<u8>),
) {
    // Bounded, so a paused pump also pauses the reads.
    let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(8);
    thread::spawn(move || {
        let mut reader = reader;
        let mut buf = vec![0; READ_CHUNK];
        // A closed pseudo console reads as an error on some systems; both end it.
        while let Ok(n @ 1..) = reader.read(&mut buf) {
            if tx.send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });
    let mut batch = Vec::new();
    let mut deadline = Instant::now();
    loop {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        let wait = if batch.is_empty() {
            POLL
        } else {
            deadline.saturating_duration_since(Instant::now())
        };
        let done = match rx.recv_timeout(wait) {
            Ok(bytes) => {
                if batch.is_empty() {
                    deadline = Instant::now() + COALESCE;
                }
                batch.extend(bytes);
                if batch.len() < MAX_BATCH && Instant::now() < deadline {
                    continue;
                }
                false
            }
            Err(RecvTimeoutError::Timeout) if batch.is_empty() => continue,
            Err(RecvTimeoutError::Timeout) => false,
            Err(RecvTimeoutError::Disconnected) => true,
        };
        if !batch.is_empty() {
            let len = batch.len();
            sink(std::mem::take(&mut batch));
            flow.sent(len);
            flow.wait_below_window(&stop);
        }
        if done {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::io;
    use std::sync::Mutex;
    use std::sync::atomic::AtomicUsize;
    use std::thread;
    use std::time::Instant;

    /// Yields each chunk after its delay, then EOF.
    struct Script(VecDeque<(Duration, Vec<u8>)>);

    impl Read for Script {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let Some((delay, mut chunk)) = self.0.pop_front() else {
                return Ok(0);
            };
            thread::sleep(delay);
            let n = chunk.len().min(buf.len());
            buf[..n].copy_from_slice(&chunk[..n]);
            if n < chunk.len() {
                self.0.push_front((Duration::ZERO, chunk.split_off(n)));
            }
            Ok(n)
        }
    }

    fn run(reader: Script) -> Vec<Vec<u8>> {
        let chunks = Mutex::new(Vec::new());
        let stop = Arc::new(AtomicBool::new(false));
        pump(reader, Arc::new(Flow::default()), stop, |c| {
            chunks.lock().unwrap().push(c)
        });
        chunks.into_inner().unwrap()
    }

    #[test]
    fn small_writes_inside_16ms_arrive_as_one_chunk() {
        let ms2 = Duration::from_millis(2);
        let script = (0..3).map(|_| (ms2, vec![b'x'; 10])).collect();
        let chunks = run(Script(script));
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].len(), 30);
    }

    #[test]
    fn flushes_on_eof() {
        let chunks = run(Script([(Duration::ZERO, b"hello".to_vec())].into()));
        assert_eq!(chunks, [b"hello".to_vec()]);
    }

    #[test]
    fn a_quiet_reader_still_flushes_after_16ms() {
        // The reader blocks long after the first bytes; they go out anyway.
        let script = [
            (Duration::ZERO, b"prompt> ".to_vec()),
            (Duration::from_millis(500), b"x".to_vec()),
        ];
        let first = Arc::new(Mutex::new(None));
        let seen = first.clone();
        let start = Instant::now();
        pump(
            Script(script.into()),
            Arc::new(Flow::default()),
            Arc::new(AtomicBool::new(false)),
            move |_| {
                seen.lock().unwrap().get_or_insert(start.elapsed());
            },
        );
        assert!(first.lock().unwrap().unwrap() < Duration::from_millis(250));
    }

    fn five_mb() -> Script {
        Script(
            (0..5 * 1024 / 64)
                .map(|_| (Duration::ZERO, vec![0; 64 * 1024]))
                .collect(),
        )
    }

    fn settle(total: &AtomicUsize) -> usize {
        let mut last = usize::MAX;
        loop {
            thread::sleep(Duration::from_millis(150));
            let now = total.load(Ordering::SeqCst);
            if now == last {
                return now;
            }
            last = now;
        }
    }

    #[test]
    fn pauses_past_window_and_resumes_on_ack() {
        let flow = Arc::new(Flow::default());
        let total = Arc::new(AtomicUsize::new(0));
        let (f, t) = (flow.clone(), total.clone());
        let handle = thread::spawn(move || {
            pump(five_mb(), f, Arc::new(AtomicBool::new(false)), move |c| {
                t.fetch_add(c.len(), Ordering::SeqCst);
            })
        });
        let paused = settle(&total);
        assert!((WINDOW..=WINDOW + 64 * 1024).contains(&paused), "{paused}");
        flow.ack(paused);
        handle.join().unwrap();
        assert_eq!(total.load(Ordering::SeqCst), 5 * 1024 * 1024);
    }

    #[test]
    fn stop_unblocks_a_paused_pump() {
        let total = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let (t, s) = (total.clone(), stop.clone());
        let handle = thread::spawn(move || {
            pump(five_mb(), Arc::new(Flow::default()), s, move |c| {
                t.fetch_add(c.len(), Ordering::SeqCst);
            })
        });
        settle(&total);
        let start = Instant::now();
        stop.store(true, Ordering::SeqCst);
        handle.join().unwrap();
        assert!(start.elapsed() < Duration::from_millis(100));
    }
}
