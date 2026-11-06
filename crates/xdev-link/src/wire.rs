//! Message transports under the Noise layer.
//!
//! A `Wire` sends and receives whole messages and polls with a short read
//! timeout, so one thread can both read and write a socket.
//! - `WsWire`: one WebSocket binary frame per message (LAN, Tailscale).
//! - `StreamWire`: a u16 BE length before each message over any `Duplex`
//!   (a relay stream, an in-memory pipe in tests).

use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use tungstenite::{Message, WebSocket};

/// How long one `poll` waits for a message.
pub const POLL: Duration = Duration::from_millis(20);

pub trait Wire: Send {
    fn send(&mut self, msg: &[u8]) -> io::Result<()>;
    /// `Ok(None)` when nothing arrived within the poll interval.
    fn poll(&mut self) -> io::Result<Option<Vec<u8>>>;
    fn close(&mut self);
    /// The far end's address, when there is one.
    fn peer_addr(&self) -> Option<String> {
        None
    }
}

/// A byte stream a relay hands over. `set_read_timeout` makes a read return
/// `WouldBlock` or `TimedOut` when nothing arrives.
pub trait Duplex: Read + Write + Send {
    fn set_read_timeout(&mut self, d: Option<Duration>) -> io::Result<()>;
}

impl Duplex for TcpStream {
    fn set_read_timeout(&mut self, d: Option<Duration>) -> io::Result<()> {
        TcpStream::set_read_timeout(self, d)
    }
}

impl<D: Duplex + ?Sized> Duplex for Box<D> {
    fn set_read_timeout(&mut self, d: Option<Duration>) -> io::Result<()> {
        (**self).set_read_timeout(d)
    }
}

fn is_timeout(e: &io::Error) -> bool {
    matches!(
        e.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut | io::ErrorKind::Interrupted
    )
}

pub struct WsWire<S: Read + Write> {
    ws: WebSocket<S>,
    addr: Option<String>,
}

impl<S: Read + Write> WsWire<S> {
    pub fn new(ws: WebSocket<S>, addr: Option<String>) -> Self {
        WsWire { ws, addr }
    }
}

fn ws_err(e: tungstenite::Error) -> io::Error {
    match e {
        tungstenite::Error::Io(e) => e,
        tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed => {
            io::Error::from(io::ErrorKind::ConnectionAborted)
        }
        _ => io::Error::from(io::ErrorKind::InvalidData),
    }
}

impl<S: Read + Write + Send> Wire for WsWire<S> {
    fn send(&mut self, msg: &[u8]) -> io::Result<()> {
        self.ws
            .send(Message::Binary(msg.to_vec().into()))
            .map_err(ws_err)
    }

    fn poll(&mut self) -> io::Result<Option<Vec<u8>>> {
        match self.ws.read() {
            Ok(Message::Binary(b)) => Ok(Some(b.to_vec())),
            Ok(Message::Close(_)) => Err(io::ErrorKind::ConnectionAborted.into()),
            // Pings are answered by tungstenite; text is not part of the protocol.
            Ok(_) => Ok(None),
            Err(tungstenite::Error::Io(e)) if is_timeout(&e) => Ok(None),
            Err(e) => Err(ws_err(e)),
        }
    }

    fn close(&mut self) {
        let _ = self.ws.close(None);
        let _ = self.ws.flush();
    }

    fn peer_addr(&self) -> Option<String> {
        self.addr.clone()
    }
}

pub struct StreamWire<D: Duplex> {
    io: D,
    buf: Vec<u8>,
    closed: bool,
}

impl<D: Duplex> StreamWire<D> {
    pub fn new(mut io: D) -> io::Result<Self> {
        io.set_read_timeout(Some(POLL))?;
        Ok(StreamWire {
            io,
            buf: Vec::new(),
            closed: false,
        })
    }

    fn take(&mut self) -> Option<Vec<u8>> {
        if self.buf.len() < 2 {
            return None;
        }
        let n = u16::from_be_bytes([self.buf[0], self.buf[1]]) as usize;
        if self.buf.len() < 2 + n {
            return None;
        }
        let msg = self.buf[2..2 + n].to_vec();
        self.buf.drain(..2 + n);
        Some(msg)
    }
}

impl<D: Duplex> Wire for StreamWire<D> {
    fn send(&mut self, msg: &[u8]) -> io::Result<()> {
        let n =
            u16::try_from(msg.len()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
        let mut out = Vec::with_capacity(2 + msg.len());
        out.extend_from_slice(&n.to_be_bytes());
        out.extend_from_slice(msg);
        self.io.write_all(&out)?;
        self.io.flush()
    }

    fn poll(&mut self) -> io::Result<Option<Vec<u8>>> {
        if let Some(m) = self.take() {
            return Ok(Some(m));
        }
        if self.closed {
            return Err(io::ErrorKind::ConnectionAborted.into());
        }
        let mut chunk = [0u8; 16 * 1024];
        match self.io.read(&mut chunk) {
            Ok(0) => {
                self.closed = true;
                Err(io::ErrorKind::ConnectionAborted.into())
            }
            Ok(n) => {
                self.buf.extend_from_slice(&chunk[..n]);
                Ok(self.take())
            }
            Err(e) if is_timeout(&e) => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn close(&mut self) {
        self.closed = true;
        let _ = self.io.flush();
    }
}

/// Reads one message, polling until `deadline`.
pub(crate) fn recv_until(
    wire: &mut dyn Wire,
    deadline: std::time::Instant,
) -> Result<Vec<u8>, crate::error::LinkError> {
    loop {
        if let Some(m) = wire.poll()? {
            return Ok(m);
        }
        if std::time::Instant::now() >= deadline {
            return Err(crate::error::LinkError::Timeout);
        }
    }
}
