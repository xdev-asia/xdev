//! Pairing at a headless host: the code and link on stdout, and the SAS
//! confirm read from stdin (ruling 8). Whoever holds the process's stdin is
//! the operator; stdin at EOF (a service) rejects every pairing.

use std::io::{BufRead, Write};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use xdev_link::server::Window;
use xdev_link::{Host, LinkError, PairOffer, PairWindow, PeerKind, PeerRole};

/// `y` or `yes`, any case.
pub fn accepts(line: &str) -> bool {
    let line = line.trim();
    line.eq_ignore_ascii_case("y") || line.eq_ignore_ascii_case("yes")
}

/// Reads one answer: `Some(role)` on a yes, `None` on anything else or EOF.
pub fn confirm_from(reader: &mut impl BufRead, role: PeerRole) -> Option<PeerRole> {
    let mut line = String::new();
    match reader.read_line(&mut line) {
        Ok(n) if n > 0 && accepts(&line) => Some(role),
        _ => None,
    }
}

pub fn kind_name(kind: PeerKind) -> &'static str {
    match kind {
        PeerKind::Desktop => "desktop",
        PeerKind::Phone => "phone",
    }
}

pub fn role_name(role: PeerRole) -> &'static str {
    match role {
        PeerRole::None => "none",
        PeerRole::Viewer => "viewer",
        PeerRole::Operator => "operator",
        PeerRole::Admin => "admin",
    }
}

pub fn prompt(name: &str, kind: PeerKind, sas: &str, role: PeerRole) -> String {
    format!(
        "pair request from {name} ({}), code check {sas}. Accept as {}? [y/N]",
        kind_name(kind),
        role_name(role)
    )
}

/// Opens the pairing window and returns the stdout lines: the code, then
/// the `xdev://pair?d=` link.
pub fn open(
    window: &Window,
    name: &str,
    now_ms: u64,
    host_pub: [u8; 32],
    candidates: Vec<String>,
) -> Result<(String, String), LinkError> {
    let w = PairWindow::new(name, now_ms)?;
    let code = w.code().display();
    let offer: PairOffer = w.offer(host_pub, candidates);
    *window.lock().unwrap_or_else(PoisonError::into_inner) = Some(w);
    Ok((
        format!("pairing code: {code}"),
        format!("pair link: {}", offer.to_uri()),
    ))
}

/// Closes the pairing window.
pub fn close(window: &Window) {
    *window.lock().unwrap_or_else(PoisonError::into_inner) = None;
}

/// Lines from stdin, read on a thread so a wait can time out. The channel
/// closes at EOF.
pub struct Answers(Mutex<Receiver<String>>);

impl Answers {
    pub fn from_lines(rx: Receiver<String>) -> Answers {
        Answers(Mutex::new(rx))
    }

    pub fn spawn(reader: impl BufRead + Send + 'static) -> Answers {
        let (tx, rx) = channel();
        std::thread::spawn(move || {
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        Answers(Mutex::new(rx))
    }

    /// Drops what was typed so far, so a stray `y` cannot accept a later
    /// request.
    pub fn forget(&self) {
        let rx = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        while rx.try_recv().is_ok() {}
    }

    /// The next line, or `None` at EOF or after `wait`.
    pub fn next(&self, wait: Duration) -> Option<String> {
        let rx = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        match rx.recv_timeout(wait) {
            Ok(line) => Some(line),
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => None,
        }
    }
}

/// One pair request: prints the prompt to `out`, waits for the answer and
/// tells the host. `true` when accepted.
#[allow(clippy::too_many_arguments)]
pub fn answer(
    host: &Host,
    answers: &Answers,
    out: &mut dyn Write,
    request_id: &str,
    name: &str,
    kind: PeerKind,
    sas: &str,
    role: PeerRole,
    wait: Duration,
) -> bool {
    answers.forget();
    let _ = writeln!(out, "{}", prompt(name, kind, sas, role));
    let _ = out.flush();
    let accept = answers.next(wait).is_some_and(|l| accepts(&l));
    host.confirm(request_id, accept, role) && accept
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::serve::host::tests::{World, dial, world};
    use serde_json::Value;
    use std::io::Cursor;
    use std::sync::Arc;
    use std::sync::mpsc::channel;
    use xdev_link::{
        Clock, Dialer, FakeDiscover, HostKey, LinkEvent, NoRelay, PairCode, PairTarget, PeerStore,
        SystemClock,
    };

    const T: Duration = Duration::from_secs(5);

    #[test]
    fn answers_from_a_reader() {
        let r = PeerRole::Operator;
        assert_eq!(confirm_from(&mut Cursor::new("y\n"), r), Some(r));
        assert_eq!(confirm_from(&mut Cursor::new("Yes\n"), r), Some(r));
        assert_eq!(confirm_from(&mut Cursor::new(" YES \r\n"), r), Some(r));
        assert_eq!(confirm_from(&mut Cursor::new("n\n"), r), None);
        assert_eq!(confirm_from(&mut Cursor::new(""), r), None);
        assert_eq!(confirm_from(&mut Cursor::new("maybe\n"), r), None);
    }

    #[test]
    fn prompt_text() {
        assert_eq!(
            prompt("mac", PeerKind::Desktop, "123 456", PeerRole::Operator),
            "pair request from mac (desktop), code check 123 456. Accept as operator? [y/N]"
        );
    }

    struct Joiner {
        dialer: Dialer,
        store: Arc<PeerStore>,
    }

    fn joiner(w: &World, name: &str) -> Joiner {
        let key = Arc::new(HostKey::generate().unwrap());
        let store = Arc::new(PeerStore::open(&w.dir.path().join(format!("{name}.json"))).unwrap());
        let mut dialer = Dialer::new(
            key,
            name,
            store.clone(),
            crate::serve::host::tests::noop_serve(),
        );
        dialer.handshake_timeout = T;
        dialer.confirm_timeout = T;
        Joiner { dialer, store }
    }

    fn offer(w: &World) -> (PairCode, PairTarget) {
        let (code, link) = open(
            &w.window,
            "box",
            SystemClock.now_ms(),
            w.key.public(),
            vec![format!("127.0.0.1:{}", w.handle.port())],
        )
        .unwrap();
        let code = PairCode::parse(code.strip_prefix("pairing code: ").unwrap()).unwrap();
        let link = link.strip_prefix("pair link: ").unwrap();
        let offer = PairOffer::from_uri(link, SystemClock.now_ms()).unwrap();
        (code, PairTarget::from_offer(&offer))
    }

    /// Runs one pairing with `stdin` as the operator's answers. The joiner's
    /// result and whether the host side accepted.
    fn pair_with(
        w: &World,
        j: &Joiner,
        code: &PairCode,
        target: &PairTarget,
        stdin: &'static str,
    ) -> (Result<xdev_link::StoredPeer, LinkError>, bool) {
        let pending = match j.dialer.pair(target, code) {
            Ok(p) => p,
            Err(e) => return (Err(e), false),
        };
        let event = loop {
            match w.events.recv_timeout(T).expect("an event") {
                e @ LinkEvent::PairRequest { .. } => break e,
                _ => continue,
            }
        };
        let LinkEvent::PairRequest {
            request_id,
            name,
            kind,
            sas,
            ..
        } = event
        else {
            unreachable!()
        };
        assert_eq!(sas, pending.sas);
        let finishing = std::thread::spawn(move || pending.finish(true));
        let (tx, rx) = channel();
        let answers = Answers::from_lines(rx);
        let mut out = Typist {
            tx: Some(tx),
            line: stdin,
            text: Vec::new(),
        };
        let accepted = answer(
            w.handle.host(),
            &answers,
            &mut out,
            &request_id,
            &name,
            kind,
            &sas,
            PeerRole::Operator,
            T,
        );
        let text = String::from_utf8(out.text).unwrap();
        assert!(text.contains("Accept as operator? [y/N]"), "{text}");
        assert!(text.contains(&sas));
        (finishing.join().unwrap(), accepted)
    }

    /// The operator: once the prompt is flushed, types `line` (each line of
    /// it), then closes stdin.
    struct Typist {
        tx: Option<std::sync::mpsc::Sender<String>>,
        line: &'static str,
        text: Vec<u8>,
    }

    impl Write for Typist {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.text.extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            if let Some(tx) = self.tx.take() {
                for l in self.line.lines() {
                    let _ = tx.send(l.to_owned());
                }
            }
            Ok(())
        }
    }

    #[test]
    fn typed_ahead_lines_are_dropped() {
        let (tx, rx) = channel();
        let answers = Answers::from_lines(rx);
        tx.send("y".to_owned()).unwrap();
        answers.forget();
        tx.send("n".to_owned()).unwrap();
        assert_eq!(answers.next(T).as_deref(), Some("n"));
        drop(tx);
        assert_eq!(answers.next(T), None);
    }

    #[test]
    fn stdin_lines_then_eof() {
        let answers = Answers::spawn(Cursor::new("yes\r\n"));
        assert!(answers.next(T).is_some_and(|l| accepts(&l)));
        assert_eq!(answers.next(T), None);
    }

    #[test]
    fn pair_then_reconnect_as_operator() {
        let w = world();
        let j = joiner(&w, "mac");
        let (code, target) = offer(&w);
        let (host, accepted) = pair_with(&w, &j, &code, &target, "y\n");
        assert!(accepted);
        let mut host = host.unwrap();
        let stored = w.store.list();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].role, PeerRole::Operator);
        assert_eq!(j.store.list().len(), 1);

        host.addrs = vec![format!("127.0.0.1:{}", w.handle.port())];
        let link = j
            .dialer
            .connect(&host, &FakeDiscover::default(), &NoRelay)
            .unwrap();
        let hello = link.call("hello", Value::Null, T).unwrap();
        assert_eq!(hello["yourRole"], "operator");

        // The code is single use.
        let again = joiner(&w, "pc");
        assert!(again.dialer.pair(&target, &code).is_err());
        assert_eq!(w.store.list().len(), 1);
    }

    #[test]
    fn eof_rejects() {
        let w = world();
        let j = joiner(&w, "mac");
        let (code, target) = offer(&w);
        let (r, accepted) = pair_with(&w, &j, &code, &target, "");
        assert!(!accepted);
        assert_eq!(r.unwrap_err(), LinkError::PairRejected);
        assert!(w.store.list().is_empty());
        assert!(j.store.list().is_empty());
    }

    #[test]
    fn no_rejects() {
        let w = world();
        let j = joiner(&w, "mac");
        let (code, target) = offer(&w);
        let (r, accepted) = pair_with(&w, &j, &code, &target, "n\n");
        assert!(!accepted);
        assert!(r.is_err());
        assert!(w.store.list().is_empty());
    }

    #[test]
    fn closed_window_refuses() {
        let w = world();
        let j = joiner(&w, "mac");
        let (code, target) = offer(&w);
        close(&w.window);
        assert!(j.dialer.pair(&target, &code).is_err());
        assert!(w.store.list().is_empty());
    }

    #[test]
    fn unknown_key_is_denied() {
        let w = world();
        let stranger = Arc::new(HostKey::generate().unwrap());
        let e = dial(&w, stranger, "stranger").unwrap_err();
        assert_eq!(e.code(), "peer_denied");
    }
}
