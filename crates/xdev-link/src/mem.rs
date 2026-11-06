//! In-memory transports for tests: a message pipe (`Wire`) and a byte pipe
//! (`Duplex`). No sockets.

use std::io::{self, Read, Write};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::time::Duration;

use crate::wire::{Duplex, POLL, Wire};

pub struct PipeWire {
    tx: Option<Sender<Vec<u8>>>,
    rx: Receiver<Vec<u8>>,
    addr: Option<String>,
}

/// Two connected message ends.
pub fn pipe() -> (PipeWire, PipeWire) {
    let (a_tx, b_rx) = channel();
    let (b_tx, a_rx) = channel();
    (
        PipeWire {
            tx: Some(a_tx),
            rx: a_rx,
            addr: Some("mem:a".into()),
        },
        PipeWire {
            tx: Some(b_tx),
            rx: b_rx,
            addr: Some("mem:b".into()),
        },
    )
}

impl Wire for PipeWire {
    fn send(&mut self, msg: &[u8]) -> io::Result<()> {
        self.tx
            .as_ref()
            .ok_or(io::ErrorKind::ConnectionAborted)?
            .send(msg.to_vec())
            .map_err(|_| io::ErrorKind::ConnectionAborted.into())
    }

    fn poll(&mut self) -> io::Result<Option<Vec<u8>>> {
        match self.rx.recv_timeout(POLL) {
            Ok(m) => Ok(Some(m)),
            Err(RecvTimeoutError::Timeout) => Ok(None),
            Err(RecvTimeoutError::Disconnected) => Err(io::ErrorKind::ConnectionAborted.into()),
        }
    }

    fn close(&mut self) {
        self.tx = None;
    }

    fn peer_addr(&self) -> Option<String> {
        self.addr.clone()
    }
}

pub struct BytePipe {
    tx: Sender<Vec<u8>>,
    rx: Receiver<Vec<u8>>,
    pending: Vec<u8>,
    timeout: Option<Duration>,
}

/// Two connected byte-stream ends.
pub fn byte_pipe() -> (BytePipe, BytePipe) {
    let (a_tx, b_rx) = channel();
    let (b_tx, a_rx) = channel();
    let end = |tx, rx| BytePipe {
        tx,
        rx,
        pending: Vec::new(),
        timeout: None,
    };
    (end(a_tx, a_rx), end(b_tx, b_rx))
}

impl Read for BytePipe {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.pending.is_empty() {
            let got = match self.timeout {
                Some(t) => match self.rx.recv_timeout(t) {
                    Ok(b) => b,
                    Err(RecvTimeoutError::Timeout) => return Err(io::ErrorKind::TimedOut.into()),
                    Err(RecvTimeoutError::Disconnected) => return Ok(0),
                },
                None => match self.rx.recv() {
                    Ok(b) => b,
                    Err(_) => return Ok(0),
                },
            };
            self.pending = got;
        }
        let n = buf.len().min(self.pending.len());
        buf[..n].copy_from_slice(&self.pending[..n]);
        self.pending.drain(..n);
        Ok(n)
    }
}

impl Write for BytePipe {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.tx
            .send(buf.to_vec())
            .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Duplex for BytePipe {
    fn set_read_timeout(&mut self, d: Option<Duration>) -> io::Result<()> {
        self.timeout = d;
        Ok(())
    }
}

/// A `Connect` that hands out wires registered per address and records
/// every address tried.
#[derive(Default)]
pub struct MemConnect {
    wires: std::sync::Mutex<Vec<(String, PipeWire)>>,
    attempts: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
}

impl MemConnect {
    pub fn add(&self, addr: &str, wire: PipeWire) {
        if let Ok(mut w) = self.wires.lock() {
            w.push((addr.to_owned(), wire));
        }
    }

    pub fn attempts(&self) -> std::sync::Arc<std::sync::Mutex<Vec<String>>> {
        self.attempts.clone()
    }
}

impl crate::dial::Connect for MemConnect {
    fn connect(&self, addr: &str) -> Result<Box<dyn Wire>, crate::error::LinkError> {
        if let Ok(mut a) = self.attempts.lock() {
            a.push(addr.to_owned());
        }
        let mut wires = self
            .wires
            .lock()
            .map_err(|_| crate::error::LinkError::Offline)?;
        let i = wires
            .iter()
            .position(|(a, _)| a == addr)
            .ok_or(crate::error::LinkError::Offline)?;
        Ok(Box::new(wires.remove(i).1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::StreamWire;

    #[test]
    fn stream_wire_frames_messages() {
        let (a, b) = byte_pipe();
        let mut a = StreamWire::new(a).unwrap();
        let mut b = StreamWire::new(b).unwrap();
        a.send(b"one").unwrap();
        a.send(&[]).unwrap();
        a.send(&vec![9u8; 40_000]).unwrap();
        let mut got = Vec::new();
        while got.len() < 3 {
            if let Some(m) = b.poll().unwrap() {
                got.push(m);
            }
        }
        assert_eq!(got[0], b"one");
        assert!(got[1].is_empty());
        assert_eq!(got[2].len(), 40_000);
        assert!(b.poll().unwrap().is_none());
        drop(a);
        assert!(b.poll().is_err());
    }
}
