use thiserror::Error;

/// Every failure the link reports. `code()` is the string the app maps to a
/// message (`peers.error.<code>`).
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum LinkError {
    #[error("not supported")]
    Unsupported,
    #[error("the peer is offline")]
    Offline,
    #[error("the pairing code is wrong or expired")]
    PairCode,
    #[error("the other side did not confirm the pairing")]
    PairRejected,
    #[error("the host is pairing with someone else")]
    PairBusy,
    #[error("the peer denied the request")]
    Denied,
    #[error("no free port in the range")]
    Port,
    #[error("the link is closed")]
    Closed,
    #[error("timed out")]
    Timeout,
    #[error("bad frame")]
    BadFrame,
    #[error("handshake failed")]
    Handshake,
    #[error("bad pairing offer: {0}")]
    Offer(&'static str),
    #[error("key store unavailable")]
    KeyStore,
    #[error("peer store: {0}")]
    Store(String),
    #[error("io: {0}")]
    Io(String),
}

impl LinkError {
    /// The stable code the app shows a message for.
    pub fn code(&self) -> &'static str {
        match self {
            LinkError::Unsupported => "unsupported",
            LinkError::Offline => "peer_offline",
            LinkError::PairCode => "pair_code",
            LinkError::PairRejected => "pair_rejected",
            LinkError::PairBusy => "pair_busy",
            LinkError::Denied => "peer_denied",
            LinkError::Port => "link_port",
            LinkError::Closed => "closed",
            LinkError::Timeout => "timeout",
            LinkError::BadFrame => "bad_frame",
            LinkError::Handshake => "handshake",
            LinkError::Offer(_) => "pair_code",
            LinkError::KeyStore => "key_store",
            LinkError::Store(_) => "peer_store",
            LinkError::Io(_) => "io",
        }
    }

    /// The error a peer sent as a code in a pairing reject frame.
    pub fn from_code(code: &str) -> LinkError {
        match code {
            "pair_code" => LinkError::PairCode,
            "pair_rejected" => LinkError::PairRejected,
            "pair_busy" => LinkError::PairBusy,
            "peer_denied" => LinkError::Denied,
            "unsupported" => LinkError::Unsupported,
            _ => LinkError::Closed,
        }
    }
}

impl From<std::io::Error> for LinkError {
    fn from(e: std::io::Error) -> Self {
        LinkError::Io(e.kind().to_string())
    }
}

impl From<snow::Error> for LinkError {
    fn from(_: snow::Error) -> Self {
        // snow's messages can name the failing stage; none of them carry key
        // material, but one variant is enough for callers.
        LinkError::Handshake
    }
}
