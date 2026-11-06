//! The log on stderr: one line per event with a UTC time (ruling 13). It
//! names peers and terms by id; it never holds a pairing code, a key, the
//! SAS, the offer link or terminal bytes.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use xdev_link::LinkEvent;

use super::host::Say;
use super::pair::role_name;

/// `2026-11-07T09:30:05Z`.
pub fn utc(at: SystemTime) -> String {
    let secs = at.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let (days, rem) = (secs / 86_400, secs % 86_400);
    let (y, m, d) = civil(days as i64);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// Days since 1970-01-01 to a proleptic Gregorian date (Howard Hinnant's
/// `civil_from_days`).
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

pub fn line(at: SystemTime, msg: &str) -> String {
    format!("{} {msg}", utc(at))
}

/// Writes each line to stderr.
pub fn stderr() -> Say {
    Arc::new(|msg: String| eprintln!("{}", line(SystemTime::now(), &msg)))
}

/// The log line of a link event. A pair request has none: its question
/// goes to stdout, and its SAS is never logged.
pub fn event(ev: &LinkEvent) -> Option<String> {
    match ev {
        LinkEvent::PairRequest { .. } => None,
        LinkEvent::Paired { peer } => {
            Some(format!("paired {} as {}", peer.id, role_name(peer.role)))
        }
        LinkEvent::PairFailed { code, .. } => Some(format!("pair failed {code}")),
        LinkEvent::Connected { peer_id, .. } => Some(format!("connected {peer_id}")),
        LinkEvent::Disconnected { peer_id } => Some(format!("disconnected {peer_id}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use xdev_link::{PeerKind, PeerRole, StoredPeer};

    #[test]
    fn utc_dates() {
        assert_eq!(utc(UNIX_EPOCH), "1970-01-01T00:00:00Z");
        let at = UNIX_EPOCH + Duration::from_secs(1_709_210_096);
        assert_eq!(utc(at), "2024-02-29T12:34:56Z");
        let at = UNIX_EPOCH + Duration::from_secs(1_794_009_600);
        assert_eq!(utc(at), "2026-11-07T00:00:00Z");
        assert_eq!(line(UNIX_EPOCH, "started"), "1970-01-01T00:00:00Z started");
    }

    #[test]
    fn events_name_ids_and_never_the_sas() {
        let sas = "482 913";
        let request = LinkEvent::PairRequest {
            request_id: "r1".into(),
            name: "mac".into(),
            kind: PeerKind::Desktop,
            sas: sas.into(),
            remote_pub: [7; 32],
        };
        assert_eq!(event(&request), None);
        let mut peer = StoredPeer::new("mac", PeerKind::Desktop, &[7; 32], 1);
        peer.role = PeerRole::Operator;
        let id = peer.id.clone();
        let paired = event(&LinkEvent::Paired { peer }).unwrap();
        assert_eq!(paired, format!("paired {id} as operator"));
        assert!(!paired.contains(sas));
        let failed = LinkEvent::PairFailed {
            request_id: Some("r1".into()),
            code: "pair_rejected",
        };
        assert_eq!(event(&failed).unwrap(), "pair failed pair_rejected");
        let gone = LinkEvent::Disconnected {
            peer_id: id.clone(),
        };
        assert_eq!(event(&gone).unwrap(), format!("disconnected {id}"));
    }
}
