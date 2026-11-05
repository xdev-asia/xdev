//! The guide that teaches agents the protocol, compiled into the binary so it
//! always matches the version that runs it.

/// The stub written to every skills root as `SKILL.md`.
pub const SKILL_MD: &str = include_str!("../guide/SKILL.md");

const MAIN: &str = include_str!("../guide/orchestration.md");

const REFERENCES: [(&str, &str); 5] = [
    (
        "coordinator-loop",
        include_str!("../guide/references/coordinator-loop.md"),
    ),
    (
        "placement",
        include_str!("../guide/references/placement.md"),
    ),
    (
        "messaging-and-gates",
        include_str!("../guide/references/messaging-and-gates.md"),
    ),
    (
        "recovery-and-cleanup",
        include_str!("../guide/references/recovery-and-cleanup.md"),
    ),
    (
        "low-level",
        include_str!("../guide/references/low-level.md"),
    ),
];

/// One guide that ships in the binary, and the skill folder it installs as.
pub struct Bundled {
    /// `orchestration`, `cli`.
    pub topic: &'static str,
    /// Folder name, e.g. `xdev-orchestration`.
    pub skill: &'static str,
    /// One line, for `skills list`.
    pub summary: &'static str,
    /// The `SKILL.md` stub.
    pub stub: &'static str,
    pub main: &'static str,
    pub references: &'static [(&'static str, &'static str)],
}

pub const BUNDLED: [Bundled; 1] = [Bundled {
    topic: "orchestration",
    skill: "xdev-orchestration",
    summary: "Run a team of agents: runs, tasks, workers, mail and decision gates.",
    stub: SKILL_MD,
    main: MAIN,
    references: &REFERENCES,
}];

/// By topic or skill folder name.
pub fn find(name: &str) -> Option<&'static Bundled> {
    BUNDLED.iter().find(|b| b.topic == name || b.skill == name)
}

/// The guide of a topic.
pub fn get(topic: &str) -> Option<&'static str> {
    find(topic).map(|b| b.main)
}

/// One reference by bare name or `references/<name>.md`.
pub fn reference(topic: &str, name: &str) -> Option<&'static str> {
    let name = name.strip_prefix("references/").unwrap_or(name);
    let name = name.strip_suffix(".md").unwrap_or(name);
    find(topic)?
        .references
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, t)| *t)
}

/// The names of every reference of a topic, in reading order.
pub fn references(topic: &str) -> Vec<&'static str> {
    find(topic).map_or_else(Vec::new, |b| b.references.iter().map(|(n, _)| *n).collect())
}

/// The guide followed by every reference, in order, separated by a blank line.
pub fn full(topic: &str) -> Option<String> {
    let b = find(topic)?;
    let mut out = b.main.trim_end().to_owned();
    for (_, text) in b.references {
        out.push_str("\n\n");
        out.push_str(text.trim_end());
    }
    out.push('\n');
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_guide_is_finished_and_within_budget() {
        let main = get("orchestration").unwrap();
        assert!(main.len() <= 6 * 1024, "{} bytes", main.len());
        for text in [SKILL_MD, main]
            .into_iter()
            .chain(REFERENCES.iter().map(|(_, t)| *t))
        {
            assert!(!text.contains("TODO"));
            assert!(!text.trim().is_empty());
        }
        assert_eq!(get("nope"), None);
    }

    #[test]
    fn every_reference_the_guide_lists_exists() {
        let main = get("orchestration").unwrap();
        let listed: Vec<&str> = main
            .lines()
            .filter_map(|l| l.strip_prefix("- `"))
            .filter_map(|l| l.split('`').next())
            .filter(|n| REFERENCES.iter().any(|(r, _)| r == n))
            .collect();
        assert_eq!(listed, references("orchestration"));
        for name in references("orchestration") {
            assert!(reference("orchestration", name).is_some());
        }
        assert_eq!(reference("orchestration", "nope"), None);
    }

    #[test]
    fn the_stub_names_the_cli_and_the_skill() {
        assert!(SKILL_MD.contains("XDEV_CLI"));
        assert!(SKILL_MD.contains("skills get orchestration"));
        assert!(SKILL_MD.starts_with(&format!("---\nname: {}\n", crate::skills::SKILL_NAME)));
    }

    #[test]
    fn find_takes_a_topic_or_a_skill_folder() {
        assert_eq!(find("orchestration").unwrap().skill, "xdev-orchestration");
        assert_eq!(find("xdev-orchestration").unwrap().topic, "orchestration");
        assert!(find("nope").is_none());
    }

    #[test]
    fn reference_accepts_a_bare_name_or_a_references_path() {
        let bare = reference("orchestration", "placement").unwrap();
        assert_eq!(
            reference("orchestration", "references/placement.md"),
            Some(bare)
        );
        assert_eq!(reference("xdev-orchestration", "placement.md"), Some(bare));
        assert_eq!(reference("nope", "placement"), None);
    }

    #[test]
    fn full_is_the_guide_then_every_reference() {
        let text = full("orchestration").unwrap();
        assert!(text.starts_with(get("orchestration").unwrap().trim_end()));
        let mut at = 0;
        for name in references("orchestration") {
            let part = reference("orchestration", name).unwrap().trim_end();
            at += text[at..].find(part).expect("in order");
        }
        assert!(full("nope").is_none());
    }
}
