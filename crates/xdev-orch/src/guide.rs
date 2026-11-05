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

/// The guide of a topic; only `orchestration` exists.
pub fn get(topic: &str) -> Option<&'static str> {
    (topic == "orchestration").then_some(MAIN)
}

/// One reference by name.
pub fn reference(name: &str) -> Option<&'static str> {
    REFERENCES.iter().find(|(n, _)| *n == name).map(|(_, t)| *t)
}

/// The names of every reference, in reading order.
pub fn references() -> Vec<&'static str> {
    REFERENCES.iter().map(|(n, _)| *n).collect()
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
        assert_eq!(listed, references());
        for name in references() {
            assert!(reference(name).is_some());
        }
        assert_eq!(reference("nope"), None);
    }

    #[test]
    fn the_stub_names_the_cli_and_the_skill() {
        assert!(SKILL_MD.contains("XDEV_CLI"));
        assert!(SKILL_MD.contains("skills get orchestration"));
        assert!(SKILL_MD.starts_with(&format!("---\nname: {}\n", crate::skills::SKILL_NAME)));
    }
}
