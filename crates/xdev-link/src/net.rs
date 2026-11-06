//! Addresses to bind and to put in an offer (M7): private LAN addresses
//! (RFC 1918, link-local excluded) and Tailscale's 100.64.0.0/10.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use crate::types::LinkBind;

pub fn is_tailscale(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            o[0] == 100 && (o[1] & 0xc0) == 64
        }
        IpAddr::V6(_) => false,
    }
}

pub fn is_private_lan(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_private() && !v4.is_link_local(),
        IpAddr::V6(_) => false,
    }
}

/// The addresses an offer lists for `bind`, from a given interface list.
pub fn candidates_from(ips: &[IpAddr], bind: LinkBind, port: u16) -> Vec<SocketAddr> {
    let mut out: Vec<SocketAddr> = match bind {
        LinkBind::Localhost => vec![SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)],
        LinkBind::Lan => ips
            .iter()
            .filter(|ip| is_private_lan(ip) || is_tailscale(ip))
            .map(|ip| SocketAddr::new(*ip, port))
            .collect(),
        LinkBind::Tailscale => ips
            .iter()
            .filter(|ip| is_tailscale(ip))
            .map(|ip| SocketAddr::new(*ip, port))
            .collect(),
    };
    // LAN first, Tailscale after: a LAN peer reaches the first one sooner.
    out.sort_by_key(|a| is_tailscale(&a.ip()));
    out.dedup();
    out
}

/// The addresses of this computer's interfaces that are up; loopback left out.
pub fn interface_ips() -> Vec<IpAddr> {
    if_addrs::get_if_addrs()
        .map(|list| {
            list.into_iter()
                .filter(|i| !i.is_loopback())
                .map(|i| i.ip())
                .collect()
        })
        .unwrap_or_default()
}

pub fn candidates(bind: LinkBind, port: u16) -> Vec<SocketAddr> {
    candidates_from(&interface_ips(), bind, port)
}

pub fn tailscale_addr() -> Option<IpAddr> {
    interface_ips().into_iter().find(is_tailscale)
}

/// The address the listener binds for `bind`. `None` for Tailscale when no
/// Tailscale interface is up.
pub fn bind_ip(bind: LinkBind) -> Option<IpAddr> {
    match bind {
        LinkBind::Localhost => Some(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        LinkBind::Lan => Some(IpAddr::V4(Ipv4Addr::UNSPECIFIED)),
        LinkBind::Tailscale => tailscale_addr(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn classify() {
        assert!(is_tailscale(&ip("100.64.0.1")));
        assert!(is_tailscale(&ip("100.127.255.255")));
        assert!(!is_tailscale(&ip("100.128.0.1")));
        assert!(!is_tailscale(&ip("100.63.0.1")));
        assert!(is_private_lan(&ip("192.168.1.20")));
        assert!(is_private_lan(&ip("10.1.2.3")));
        assert!(!is_private_lan(&ip("169.254.1.1")));
        assert!(!is_private_lan(&ip("8.8.8.8")));
    }

    #[test]
    fn candidates_by_bind() {
        let ips = [
            ip("100.101.102.103"),
            ip("192.168.1.20"),
            ip("169.254.0.9"),
            ip("8.8.8.8"),
            ip("fe80::1"),
        ];
        let lan: Vec<String> = candidates_from(&ips, LinkBind::Lan, 47821)
            .iter()
            .map(|a| a.to_string())
            .collect();
        assert_eq!(lan, ["192.168.1.20:47821", "100.101.102.103:47821"]);
        let ts: Vec<String> = candidates_from(&ips, LinkBind::Tailscale, 1)
            .iter()
            .map(|a| a.to_string())
            .collect();
        assert_eq!(ts, ["100.101.102.103:1"]);
        let local = candidates_from(&ips, LinkBind::Localhost, 2);
        assert_eq!(local[0].to_string(), "127.0.0.1:2");
    }
}
