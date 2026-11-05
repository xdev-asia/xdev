//! Reads between linked tabs. A link is directional: the reader may look at
//! the target only through a grant the person turned on, and every grant
//! starts off. The check asks the book each time, so a grant taken back is
//! refused on the very next read, and a link whose target closed is dropped.

use serde::{Deserialize, Serialize};

use crate::Verdict;

/// What a reader wants of the target tab.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadKind {
    /// The target's messages and conversation.
    Transcript,
    /// The text on the target's terminal screen; it may show secrets.
    Screen,
}

/// The grants of one link; both off unless the person turned them on.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Grants {
    pub transcript: bool,
    pub screen: bool,
}

impl Grants {
    pub fn allows(self, kind: ReadKind) -> bool {
        match kind {
            ReadKind::Transcript => self.transcript,
            ReadKind::Screen => self.screen,
        }
    }
}

/// Where the links and the open tabs are looked up, read fresh on every check.
pub trait LinkBook {
    /// The grants of the link `reader -> target`; none when there is no link.
    fn grants(&self, reader: &str, target: &str) -> Option<Grants>;
    /// Whether `tab` is still open.
    fn is_open(&self, tab: &str) -> bool;
    /// Forgets the link `reader -> target`.
    fn prune(&mut self, reader: &str, target: &str);
}

/// Whether `reader` may read `kind` of `target`. A tab may always read
/// itself. A link to a closed tab is pruned and the read refused.
pub fn check_read(book: &mut dyn LinkBook, reader: &str, target: &str, kind: ReadKind) -> Verdict {
    if reader == target {
        return Verdict::Allow;
    }
    let link = book.grants(reader, target);
    if !book.is_open(target) {
        if link.is_some() {
            book.prune(reader, target);
        }
        return Verdict::Deny {
            reason: format!("tab {target} is closed"),
        };
    }
    let Some(grants) = link else {
        return Verdict::Deny {
            reason: format!("tab {reader} is not linked to {target}"),
        };
    };
    if grants.allows(kind) {
        Verdict::Allow
    } else {
        let what = match kind {
            ReadKind::Transcript => "transcript",
            ReadKind::Screen => "screen",
        };
        Verdict::Deny {
            reason: format!("the link {reader} -> {target} has no {what} grant"),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};

    use super::*;

    #[derive(Default)]
    struct Book {
        links: HashMap<(String, String), Grants>,
        open: HashSet<String>,
        pruned: Vec<(String, String)>,
    }

    impl Book {
        fn with(open: &[&str]) -> Book {
            Book {
                open: open.iter().map(|t| (*t).to_owned()).collect(),
                ..Book::default()
            }
        }
        fn link(&mut self, a: &str, b: &str, g: Grants) {
            self.links.insert((a.to_owned(), b.to_owned()), g);
        }
    }

    impl LinkBook for Book {
        fn grants(&self, reader: &str, target: &str) -> Option<Grants> {
            self.links
                .get(&(reader.to_owned(), target.to_owned()))
                .copied()
        }
        fn is_open(&self, tab: &str) -> bool {
            self.open.contains(tab)
        }
        fn prune(&mut self, reader: &str, target: &str) {
            self.links.remove(&(reader.to_owned(), target.to_owned()));
            self.pruned.push((reader.to_owned(), target.to_owned()));
        }
    }

    fn denied(v: &Verdict) -> bool {
        matches!(v, Verdict::Deny { .. })
    }

    #[test]
    fn grants_start_off() {
        let g = Grants::default();
        assert!(!g.allows(ReadKind::Transcript));
        assert!(!g.allows(ReadKind::Screen));
    }

    #[test]
    fn no_link_is_denied() {
        let mut b = Book::with(&["a", "b"]);
        assert!(denied(&check_read(&mut b, "a", "b", ReadKind::Transcript)));
        assert!(denied(&check_read(&mut b, "a", "b", ReadKind::Screen)));
    }

    #[test]
    fn a_new_link_without_grants_is_denied() {
        let mut b = Book::with(&["a", "b"]);
        b.link("a", "b", Grants::default());
        assert!(denied(&check_read(&mut b, "a", "b", ReadKind::Transcript)));
        assert!(denied(&check_read(&mut b, "a", "b", ReadKind::Screen)));
    }

    #[test]
    fn each_grant_opens_only_its_own_read() {
        let mut b = Book::with(&["a", "b"]);
        b.link(
            "a",
            "b",
            Grants {
                transcript: true,
                screen: false,
            },
        );
        assert_eq!(
            check_read(&mut b, "a", "b", ReadKind::Transcript),
            Verdict::Allow
        );
        assert!(denied(&check_read(&mut b, "a", "b", ReadKind::Screen)));
    }

    #[test]
    fn a_link_is_one_way() {
        let mut b = Book::with(&["a", "b"]);
        b.link(
            "a",
            "b",
            Grants {
                transcript: true,
                screen: true,
            },
        );
        assert!(denied(&check_read(&mut b, "b", "a", ReadKind::Transcript)));
    }

    #[test]
    fn a_revoked_grant_is_denied_at_once() {
        let mut b = Book::with(&["a", "b"]);
        let on = Grants {
            transcript: true,
            screen: true,
        };
        b.link("a", "b", on);
        assert_eq!(
            check_read(&mut b, "a", "b", ReadKind::Screen),
            Verdict::Allow
        );
        b.link(
            "a",
            "b",
            Grants {
                screen: false,
                ..on
            },
        );
        assert!(denied(&check_read(&mut b, "a", "b", ReadKind::Screen)));
        assert_eq!(
            check_read(&mut b, "a", "b", ReadKind::Transcript),
            Verdict::Allow
        );
    }

    #[test]
    fn a_link_to_a_closed_tab_is_pruned_and_denied() {
        let mut b = Book::with(&["a"]);
        b.link(
            "a",
            "b",
            Grants {
                transcript: true,
                screen: true,
            },
        );
        assert!(denied(&check_read(&mut b, "a", "b", ReadKind::Transcript)));
        assert_eq!(b.pruned, [("a".to_owned(), "b".to_owned())]);
        assert!(b.grants("a", "b").is_none());
        // Nothing left to prune the second time.
        assert!(denied(&check_read(&mut b, "a", "b", ReadKind::Transcript)));
        assert_eq!(b.pruned.len(), 1);
    }

    #[test]
    fn a_tab_may_read_itself() {
        let mut b = Book::with(&["a"]);
        assert_eq!(
            check_read(&mut b, "a", "a", ReadKind::Screen),
            Verdict::Allow
        );
    }

    #[test]
    fn kinds_serialise_in_snake_case() {
        assert_eq!(
            serde_json::to_string(&ReadKind::Transcript).unwrap(),
            "\"transcript\""
        );
    }
}
