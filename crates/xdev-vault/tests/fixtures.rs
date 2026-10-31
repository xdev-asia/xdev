//! Runs the shared fixtures that the TypeScript parsers run too, so the index
//! and the editor never disagree on a title or a link.

use serde_json::Value;
use xdev_vault::{extract_title, parse_frontmatter};

const FRONTMATTER: &str = include_str!("../../../fixtures/frontmatter.json");

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn frontmatter_fixtures() {
    let spec: Value = serde_json::from_str(FRONTMATTER).unwrap();
    let path = spec["path"].as_str().unwrap();
    for case in spec["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let input = case["input"].as_str().unwrap();
        let (fm, body) = parse_frontmatter(input);
        assert_eq!(body, case["body"].as_str().unwrap(), "case {name}: body");
        assert_eq!(
            extract_title(path, input),
            case["title"].as_str().unwrap(),
            "case {name}: title"
        );
        // Serialized, because the UI receives targets as lowercase strings.
        assert_eq!(
            serde_json::to_value(&fm.agents).unwrap(),
            case["agents"],
            "case {name}: agents"
        );
        assert_eq!(fm.tags, strings(&case["tags"]), "case {name}: tags");
    }
}
