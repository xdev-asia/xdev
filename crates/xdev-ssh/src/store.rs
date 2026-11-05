//! The hosts file and the changes made to a list of hosts.

use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::{HostSource, STORE_FILE, SshError, SshHost, validate};

#[derive(Serialize, Deserialize, Default)]
struct File {
    #[serde(default)]
    hosts: Vec<SshHost>,
}

/// The hosts in `dir`; none when the file is missing.
pub fn load(dir: &Path) -> Result<Vec<SshHost>, SshError> {
    match fs::read(dir.join(STORE_FILE)) {
        Ok(bytes) => serde_json::from_slice::<File>(&bytes)
            .map(|f| f.hosts)
            .map_err(|e| SshError::Io(e.to_string())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.into()),
    }
}

/// Writes `hosts` whole: a temp file beside the target, flushed, renamed.
pub fn save(dir: &Path, hosts: &[SshHost]) -> Result<(), SshError> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    fs::create_dir_all(dir)?;
    let bytes = serde_json::to_vec_pretty(&File {
        hosts: hosts.to_vec(),
    })
    .map_err(|e| SshError::Io(e.to_string()))?;
    let tmp = dir.join(format!(
        ".{STORE_FILE}-{}-{}.tmp",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut f = fs::File::create_new(&tmp)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, dir.join(STORE_FILE))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    Ok(result?)
}

/// Adds `host` or replaces the one with its id. `host.id` must be set by the
/// caller for a new host. The alias must stay unique. Returns the stored host.
pub fn upsert(hosts: &mut Vec<SshHost>, host: &SshHost) -> Result<SshHost, SshError> {
    let host = validate(host)?;
    if hosts
        .iter()
        .any(|h| h.alias == host.alias && h.id != host.id)
    {
        return Err(SshError::DuplicateAlias);
    }
    match hosts.iter_mut().find(|h| h.id == host.id) {
        Some(slot) => *slot = host.clone(),
        None => hosts.push(host.clone()),
    }
    Ok(host)
}

pub fn remove(hosts: &mut Vec<SshHost>, id: &str) -> Result<(), SshError> {
    let before = hosts.len();
    hosts.retain(|h| h.id != id);
    if hosts.len() == before {
        return Err(SshError::NotFound);
    }
    Ok(())
}

/// Removes every host in `ids`; returns how many went.
pub fn remove_many(hosts: &mut Vec<SshHost>, ids: &[String]) -> usize {
    let before = hosts.len();
    hosts.retain(|h| !ids.contains(&h.id));
    before - hosts.len()
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SyncCounts {
    pub added: u32,
    pub updated: u32,
    pub unchanged: u32,
    /// Config aliases left alone because a manual host has the same alias.
    pub skipped: u32,
}

/// Brings `parsed` (the hosts of a config; ids are ignored) into `hosts`:
/// new aliases are added with `new_id(alias)`, `SshConfig` ones are updated,
/// `Manual` ones are never touched.
pub fn merge_config(
    hosts: &mut Vec<SshHost>,
    parsed: &[SshHost],
    new_id: &mut dyn FnMut(&str) -> String,
) -> SyncCounts {
    let mut counts = SyncCounts::default();
    for item in parsed {
        match hosts.iter_mut().find(|h| h.alias == item.alias) {
            None => {
                hosts.push(SshHost {
                    id: new_id(&item.alias),
                    source: HostSource::SshConfig,
                    ..item.clone()
                });
                counts.added += 1;
            }
            Some(h) if h.source == HostSource::Manual => counts.skipped += 1,
            Some(h) => {
                let next = SshHost {
                    id: h.id.clone(),
                    source: HostSource::SshConfig,
                    ..item.clone()
                };
                if *h == next {
                    counts.unchanged += 1;
                } else {
                    *h = next;
                    counts.updated += 1;
                }
            }
        }
    }
    counts
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host;

    #[test]
    fn missing_file_is_empty_and_save_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load(dir.path()).unwrap().is_empty());
        let nested = dir.path().join("a/b");
        let hosts = vec![host("one"), host("two")];
        save(&nested, &hosts).unwrap();
        assert_eq!(load(&nested).unwrap(), hosts);
        // No temp file is left behind.
        let names: Vec<_> = fs::read_dir(&nested)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, [STORE_FILE]);
        save(&nested, &[]).unwrap();
        assert!(load(&nested).unwrap().is_empty());
    }

    #[test]
    fn broken_file_is_an_error_not_empty() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(STORE_FILE), "{nope").unwrap();
        assert!(matches!(load(dir.path()), Err(SshError::Io(_))));
        // A file without the key loads as empty.
        fs::write(dir.path().join(STORE_FILE), "{}").unwrap();
        assert!(load(dir.path()).unwrap().is_empty());
    }

    #[test]
    fn upsert_adds_replaces_and_keeps_aliases_unique() {
        let mut hosts = Vec::new();
        upsert(&mut hosts, &host("a")).unwrap();
        upsert(&mut hosts, &host("b")).unwrap();
        let mut edit = host("a");
        edit.user = Some("me".into());
        upsert(&mut hosts, &edit).unwrap();
        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0].user.as_deref(), Some("me"));
        let mut clash = host("b");
        clash.id = "other".into();
        assert_eq!(upsert(&mut hosts, &clash), Err(SshError::DuplicateAlias));
        let mut bad = host("c");
        bad.alias = "c d".into();
        assert_eq!(upsert(&mut hosts, &bad), Err(SshError::Alias));
        assert_eq!(hosts.len(), 2);
    }

    #[test]
    fn remove_one_and_many() {
        let mut hosts = vec![host("a"), host("b"), host("c")];
        remove(&mut hosts, "id-b").unwrap();
        assert_eq!(remove(&mut hosts, "id-b"), Err(SshError::NotFound));
        let n = remove_many(&mut hosts, &["id-a".into(), "id-zzz".into()]);
        assert_eq!(n, 1);
        assert_eq!(hosts.len(), 1);
    }

    #[test]
    fn merge_adds_updates_and_spares_manual_hosts() {
        let mut manual = host("keep");
        manual.host_name = "mine".into();
        let mut cfg = host("cfg");
        cfg.source = HostSource::SshConfig;
        cfg.id = "cfg-id".into();
        let mut same = host("same");
        same.source = HostSource::SshConfig;
        let mut hosts = vec![manual.clone(), cfg.clone(), same.clone()];

        let parsed = [
            SshHost {
                host_name: "theirs".into(),
                id: String::new(),
                ..host("keep")
            },
            SshHost {
                host_name: "new.example.com".into(),
                id: String::new(),
                source: HostSource::SshConfig,
                ..host("cfg")
            },
            SshHost {
                id: String::new(),
                source: HostSource::SshConfig,
                ..host("same")
            },
            SshHost {
                id: String::new(),
                source: HostSource::SshConfig,
                ..host("fresh")
            },
        ];
        let counts = merge_config(&mut hosts, &parsed, &mut |a| format!("n-{a}"));
        assert_eq!(
            counts,
            SyncCounts {
                added: 1,
                updated: 1,
                unchanged: 1,
                skipped: 1
            }
        );
        assert_eq!(hosts[0], manual);
        assert_eq!(hosts[1].id, "cfg-id");
        assert_eq!(hosts[1].host_name, "new.example.com");
        assert_eq!(hosts[3].id, "n-fresh");
        // A second run changes nothing.
        let again = merge_config(&mut hosts, &parsed, &mut |a| format!("n-{a}"));
        assert_eq!(
            again,
            SyncCounts {
                added: 0,
                updated: 0,
                unchanged: 3,
                skipped: 1
            }
        );
    }
}
