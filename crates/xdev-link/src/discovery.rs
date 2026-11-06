//! LAN discovery over mDNS (`_xdev-link._tcp.local.`).
//!
//! Always announced: `v=1`, `f=<host id>`, `p=0`. While the pair dialog is
//! open: `p=1` and `n=<name>`, so the name never leaks otherwise. Disabled
//! when the listener binds to localhost.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};

use crate::error::LinkError;
use crate::types::LinkBind;

pub const SERVICE: &str = "_xdev-link._tcp.local.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Nearby {
    pub host_id: String,
    pub name: Option<String>,
    pub addrs: Vec<SocketAddr>,
    pub pairing: bool,
}

pub trait Discover: Send + Sync {
    /// `Some(name)` announces pairing; `None` goes back to `p=0`.
    fn set_pairing(&self, name: Option<&str>) -> Result<(), LinkError>;
    fn pairing(&self) -> bool;
    /// Hosts as they are resolved. Each call gets its own receiver.
    fn browse(&self) -> Result<Receiver<Nearby>, LinkError>;
    /// The last addresses seen for `host_id`.
    fn resolve(&self, host_id: &str) -> Vec<SocketAddr>;
}

/// The TXT records for the announcement.
pub fn txt(host_id: &str, pairing_name: Option<&str>) -> Vec<(String, String)> {
    let mut out = vec![
        ("v".to_owned(), "1".to_owned()),
        ("f".to_owned(), host_id.to_owned()),
        (
            "p".to_owned(),
            if pairing_name.is_some() { "1" } else { "0" }.to_owned(),
        ),
    ];
    if let Some(n) = pairing_name {
        out.push(("n".to_owned(), n.to_owned()));
    }
    out
}

/// A `Nearby` from TXT values. `None` for another version or no host id.
pub fn nearby_from(get: impl Fn(&str) -> Option<String>, addrs: Vec<SocketAddr>) -> Option<Nearby> {
    if get("v").as_deref() != Some("1") {
        return None;
    }
    let host_id = get("f").filter(|f| !f.is_empty())?;
    let pairing = get("p").as_deref() == Some("1");
    Some(Nearby {
        host_id,
        name: if pairing { get("n") } else { None },
        addrs,
        pairing,
    })
}

type Seen = Arc<Mutex<HashMap<String, Nearby>>>;

struct Live {
    daemon: ServiceDaemon,
    fullname: Mutex<String>,
}

/// The real mDNS announcer and browser. Inert when the bind is localhost.
pub struct Discovery {
    host_id: String,
    port: u16,
    live: Option<Live>,
    pairing: Mutex<Option<String>>,
    seen: Seen,
}

impl Discovery {
    pub fn start(host_id: &str, port: u16, bind: LinkBind) -> Result<Discovery, LinkError> {
        let mut d = Discovery {
            host_id: host_id.to_owned(),
            port,
            live: None,
            pairing: Mutex::new(None),
            seen: Arc::default(),
        };
        if bind == LinkBind::Localhost {
            return Ok(d);
        }
        let daemon = ServiceDaemon::new().map_err(|_| LinkError::Io("mdns".into()))?;
        d.live = Some(Live {
            daemon,
            fullname: Mutex::new(String::new()),
        });
        d.register(None)?;
        Ok(d)
    }

    pub fn is_enabled(&self) -> bool {
        self.live.is_some()
    }

    fn register(&self, name: Option<&str>) -> Result<(), LinkError> {
        let Some(live) = &self.live else {
            return Ok(());
        };
        let info = ServiceInfo::new(
            SERVICE,
            &self.host_id,
            &format!("{}.local.", self.host_id),
            "",
            self.port,
            &txt(&self.host_id, name)[..],
        )
        .map_err(|_| LinkError::Io("mdns".into()))?
        .enable_addr_auto();
        let mut fullname = live
            .fullname
            .lock()
            .map_err(|_| LinkError::Io("mdns".into()))?;
        if !fullname.is_empty() {
            let _ = live.daemon.unregister(&fullname);
        }
        *fullname = info.get_fullname().to_owned();
        live.daemon
            .register(info)
            .map_err(|_| LinkError::Io("mdns".into()))
    }

    pub fn stop(&self) {
        if let Some(live) = &self.live {
            let _ = live.daemon.shutdown();
        }
    }
}

impl Drop for Discovery {
    fn drop(&mut self) {
        self.stop();
    }
}

impl Discover for Discovery {
    fn set_pairing(&self, name: Option<&str>) -> Result<(), LinkError> {
        if let Ok(mut p) = self.pairing.lock() {
            *p = name.map(str::to_owned);
        }
        self.register(name)
    }

    fn pairing(&self) -> bool {
        self.pairing.lock().map(|p| p.is_some()).unwrap_or(false)
    }

    fn browse(&self) -> Result<Receiver<Nearby>, LinkError> {
        let (tx, rx) = channel();
        let Some(live) = &self.live else {
            return Ok(rx);
        };
        let events = live
            .daemon
            .browse(SERVICE)
            .map_err(|_| LinkError::Io("mdns".into()))?;
        let own = self.host_id.clone();
        let seen = self.seen.clone();
        std::thread::Builder::new()
            .name("xdev-link-browse".into())
            .spawn(move || forward(events, own, seen, tx))
            .map_err(LinkError::from)?;
        Ok(rx)
    }

    fn resolve(&self, host_id: &str) -> Vec<SocketAddr> {
        self.seen
            .lock()
            .ok()
            .and_then(|s| s.get(host_id).map(|n| n.addrs.clone()))
            .unwrap_or_default()
    }
}

fn forward(events: mdns_sd::Receiver<ServiceEvent>, own: String, seen: Seen, tx: Sender<Nearby>) {
    while let Ok(ev) = events.recv() {
        let ServiceEvent::ServiceResolved(info) = ev else {
            continue;
        };
        let port = info.get_port();
        let addrs: Vec<SocketAddr> = info
            .get_addresses()
            .iter()
            .map(|a| a.to_ip_addr())
            .filter(|ip: &IpAddr| ip.is_ipv4())
            .map(|ip| SocketAddr::new(ip, port))
            .collect();
        let Some(n) = nearby_from(|k| info.get_property_val_str(k).map(str::to_owned), addrs)
        else {
            continue;
        };
        if n.host_id == own {
            continue;
        }
        if let Ok(mut s) = seen.lock() {
            s.insert(n.host_id.clone(), n.clone());
        }
        if tx.send(n).is_err() {
            break;
        }
    }
}

/// A discovery double: a pairing flag and a fixed list of hosts.
#[derive(Default)]
pub struct FakeDiscover {
    pairing: Mutex<Option<String>>,
    hosts: Mutex<Vec<Nearby>>,
}

impl FakeDiscover {
    pub fn with_hosts(hosts: Vec<Nearby>) -> FakeDiscover {
        FakeDiscover {
            pairing: Mutex::default(),
            hosts: Mutex::new(hosts),
        }
    }

    pub fn pairing_name(&self) -> Option<String> {
        self.pairing.lock().ok().and_then(|p| p.clone())
    }
}

impl Discover for FakeDiscover {
    fn set_pairing(&self, name: Option<&str>) -> Result<(), LinkError> {
        if let Ok(mut p) = self.pairing.lock() {
            *p = name.map(str::to_owned);
        }
        Ok(())
    }

    fn pairing(&self) -> bool {
        self.pairing_name().is_some()
    }

    fn browse(&self) -> Result<Receiver<Nearby>, LinkError> {
        let (tx, rx) = channel();
        for h in self.hosts.lock().map(|h| h.clone()).unwrap_or_default() {
            let _ = tx.send(h);
        }
        Ok(rx)
    }

    fn resolve(&self, host_id: &str) -> Vec<SocketAddr> {
        self.hosts
            .lock()
            .ok()
            .and_then(|h| {
                h.iter()
                    .find(|n| n.host_id == host_id)
                    .map(|n| n.addrs.clone())
            })
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn txt_announces_the_name_only_while_pairing() {
        let idle = txt("abc", None);
        assert!(idle.contains(&("p".into(), "0".into())));
        assert!(!idle.iter().any(|(k, _)| k == "n"));
        let open = txt("abc", Some("studio-mac"));
        assert!(open.contains(&("p".into(), "1".into())));
        assert!(open.contains(&("n".into(), "studio-mac".into())));
        assert!(open.contains(&("f".into(), "abc".into())));
    }

    #[test]
    fn nearby_parse() {
        let map = |pairs: Vec<(String, String)>| {
            move |k: &str| pairs.iter().find(|(a, _)| a == k).map(|(_, v)| v.clone())
        };
        let n = nearby_from(map(txt("abc", Some("box"))), vec![]).unwrap();
        assert!(n.pairing);
        assert_eq!(n.name.as_deref(), Some("box"));
        let n = nearby_from(map(txt("abc", None)), vec![]).unwrap();
        assert!(!n.pairing);
        assert_eq!(n.name, None);
        assert!(nearby_from(map(vec![("v".into(), "2".into())]), vec![]).is_none());
    }

    #[test]
    fn fake_pairing_flag() {
        let d = FakeDiscover::default();
        assert!(!d.pairing());
        d.set_pairing(Some("this-pc")).unwrap();
        assert!(d.pairing());
        assert_eq!(d.pairing_name().as_deref(), Some("this-pc"));
        d.set_pairing(None).unwrap();
        assert!(!d.pairing());
    }

    #[test]
    fn localhost_is_inert() {
        let d = Discovery::start("abc", 47821, LinkBind::Localhost).unwrap();
        assert!(!d.is_enabled());
        d.set_pairing(Some("x")).unwrap();
        assert!(d.pairing());
        assert!(d.browse().unwrap().try_recv().is_err());
    }
}
