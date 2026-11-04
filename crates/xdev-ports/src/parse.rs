//! Readers for the listener tables each OS prints. Pure: text in, rows out.

use std::net::{Ipv4Addr, Ipv6Addr};

use crate::Listener;

/// Splits `host:port` where the port follows the last `sep`. A bracketed IPv6
/// host loses its brackets.
fn split_addr(addr: &str, sep: char) -> Option<(String, u16)> {
    let (host, port) = addr.rsplit_once(sep)?;
    let port = port.parse::<u16>().ok()?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host.is_empty() {
        return None;
    }
    Some((host.to_owned(), port))
}

/// `netstat -ano -p tcp` and `-p tcpv6` on Windows.
///
/// The state word is localised, so a row counts as a listener by its shape: a
/// foreign address of port 0 on the unspecified host. Columns are protocol,
/// local, foreign, state (which may be several words), pid.
pub fn parse_netstat_windows(text: &str) -> Vec<Listener> {
    text.lines()
        .filter_map(|line| {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() < 5 || !cols[0].to_ascii_uppercase().starts_with("TCP") {
                return None;
            }
            let (host, port) = split_addr(cols[1], ':')?;
            let (fhost, fport) = split_addr(cols[2], ':')?;
            if fport != 0 || !matches!(fhost.as_str(), "0.0.0.0" | "::") {
                return None;
            }
            let pid = cols[cols.len() - 1].parse::<u32>().ok()?;
            Some(Listener {
                bind_host: host,
                port,
                pid: Some(pid).filter(|p| *p != 0),
            })
        })
        .collect()
}

/// `lsof -nP -iTCP -sTCP:LISTEN -F pcn`: a `p` line starts a process, each `n`
/// line is one socket name such as `*:5173` or `[::1]:3000`.
pub fn parse_lsof(text: &str) -> Vec<Listener> {
    let mut pid: Option<u32> = None;
    let mut out = Vec::new();
    for line in text.lines() {
        let Some(tag) = line.chars().next() else {
            continue;
        };
        let rest = &line[tag.len_utf8()..];
        match tag {
            'p' => pid = rest.parse().ok(),
            'n' if !rest.contains("->") => {
                if let Some((host, port)) = split_addr(rest, ':') {
                    out.push(Listener {
                        bind_host: host,
                        port,
                        pid,
                    });
                }
            }
            _ => {}
        }
    }
    out
}

/// `netstat -aln -p tcp` on macOS, without pids. The port follows the last dot
/// of an address; only rows in the `LISTEN` state count.
pub fn parse_netstat_macos(text: &str) -> Vec<Listener> {
    text.lines()
        .filter_map(|line| {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() < 6 || !cols[0].starts_with("tcp") || cols[5] != "LISTEN" {
                return None;
            }
            let (host, port) = split_addr(cols[3], '.')?;
            Some(Listener {
                bind_host: host,
                port,
                pid: None,
            })
        })
        .collect()
}

fn hex_words(hex: &str) -> Option<Vec<u32>> {
    if !hex.is_ascii() || !hex.len().is_multiple_of(8) {
        return None;
    }
    (0..hex.len())
        .step_by(8)
        .map(|i| u32::from_str_radix(&hex[i..i + 8], 16).ok())
        .collect()
}

/// `/proc/net/tcp` (and `tcp6` with `v6`): rows in state `0A` (listen), as
/// `(bind host, port, socket inode)`. Addresses are little-endian hex words;
/// the inode is decimal.
pub fn parse_proc_net_tcp(text: &str, v6: bool) -> Vec<(String, u16, u64)> {
    text.lines()
        .skip(1)
        .filter_map(|line| {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() < 10 || cols[3] != "0A" {
                return None;
            }
            let (addr, port) = cols[1].split_once(':')?;
            let port = u16::from_str_radix(port, 16).ok()?;
            let words = hex_words(addr)?;
            let host = if v6 {
                let words = <[u32; 4]>::try_from(words).ok()?;
                let mut octets = [0u8; 16];
                for (i, w) in words.iter().enumerate() {
                    octets[i * 4..i * 4 + 4].copy_from_slice(&w.to_le_bytes());
                }
                Ipv6Addr::from(octets).to_string()
            } else {
                let [w] = <[u32; 1]>::try_from(words).ok()?;
                Ipv4Addr::from(w.to_le_bytes()).to_string()
            };
            let inode = cols[9].parse::<u64>().ok()?;
            Some((host, port, inode))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn l(host: &str, port: u16, pid: Option<u32>) -> Listener {
        Listener {
            bind_host: host.into(),
            port,
            pid,
        }
    }

    #[test]
    fn windows_rows_are_read_by_shape_not_by_the_state_word() {
        let text = "\
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1234
  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       4101
  TCP    127.0.0.1:5173         127.0.0.1:50000        ESTABLISHED     4101
  TCP    192.168.1.5:8080       0.0.0.0:0              \u{110}ANG NGHE     77
  TCP    [::]:445               [::]:0                 LISTENING       4
  TCP    [::1]:3000             [::]:0                 LISTENING       99
  UDP    0.0.0.0:5353           *:*                                    12
";
        assert_eq!(
            parse_netstat_windows(text),
            vec![
                l("0.0.0.0", 135, Some(1234)),
                l("127.0.0.1", 5173, Some(4101)),
                l("192.168.1.5", 8080, Some(77)),
                l("::", 445, Some(4)),
                l("::1", 3000, Some(99)),
            ]
        );
    }

    #[test]
    fn windows_pid_zero_is_no_pid_and_junk_is_skipped() {
        let text = "  TCP    0.0.0.0:80   0.0.0.0:0   LISTENING   0\n  TCP    x   y\nnonsense\n";
        assert_eq!(parse_netstat_windows(text), vec![l("0.0.0.0", 80, None)]);
    }

    #[test]
    fn lsof_groups_sockets_under_their_process() {
        let text = "p812\ncnode\nn*:5173\nn[::1]:3000\np900\ncpostgres\nn127.0.0.1:5432\nn127.0.0.1:5432->127.0.0.1:60000\n";
        assert_eq!(
            parse_lsof(text),
            vec![
                l("*", 5173, Some(812)),
                l("::1", 3000, Some(812)),
                l("127.0.0.1", 5432, Some(900)),
            ]
        );
    }

    #[test]
    fn macos_netstat_reads_listeners_without_pids() {
        let text = "\
Active Internet connections (including servers)
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)
tcp4       0      0  127.0.0.1.3000         *.*                    LISTEN
tcp46      0      0  *.5173                 *.*                    LISTEN
tcp6       0      0  ::1.8080               *.*                    LISTEN
tcp4       0      0  127.0.0.1.3000         127.0.0.1.50000        ESTABLISHED
";
        assert_eq!(
            parse_netstat_macos(text),
            vec![
                l("127.0.0.1", 3000, None),
                l("*", 5173, None),
                l("::1", 8080, None),
            ]
        );
    }

    #[test]
    fn proc_net_tcp_keeps_only_listen_rows_and_decodes_hex() {
        let text = "\
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0
   1: 00000000:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 777 1 0000000000000000 100 0 0 10 0
   2: 0100007F:1F90 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 999 1 0000000000000000 100 0 0 10 0
";
        assert_eq!(
            parse_proc_net_tcp(text, false),
            vec![
                ("127.0.0.1".to_owned(), 8080, 12345),
                ("0.0.0.0".to_owned(), 5173, 777)
            ]
        );
    }

    #[test]
    fn proc_net_tcp6_decodes_four_little_endian_words() {
        let text = "\
  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000000000000:1435 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4243 1 0000000000000000 100 0 0 10 0
   2: 00000000000000000000000000000000:1435 00000000000000000000000000000000:0000 06 00000000:00000000 00:00000000 00000000  1000        0 4244 1 0000000000000000 100 0 0 10 0
";
        assert_eq!(
            parse_proc_net_tcp(text, true),
            vec![
                ("::1".to_owned(), 3000, 4242),
                ("::".to_owned(), 5173, 4243)
            ]
        );
    }

    #[test]
    fn a_short_or_odd_row_is_skipped() {
        assert!(parse_proc_net_tcp("header\n 0: ZZ:1 x 0A\n", false).is_empty());
        assert!(parse_lsof("p1\nnno-colon\n").is_empty());
    }
}
