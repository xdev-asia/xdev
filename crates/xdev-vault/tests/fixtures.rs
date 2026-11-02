//! Runs the shared fixtures that the TypeScript parsers run too, so the index
//! and the editor never disagree on a title or a link.

use serde_json::Value;
use xdev_vault::{LinkKind, Resolver, extract_title, parse_frontmatter, parse_links};

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
        let covers = case.get("covers").map_or_else(Vec::new, strings);
        assert_eq!(fm.covers, covers, "case {name}: covers");
        let optional = |key: &str| case.get(key).and_then(Value::as_str).map(str::to_owned);
        assert_eq!(fm.verified, optional("verified"), "case {name}: verified");
        assert_eq!(fm.doc_type, optional("type"), "case {name}: type");
    }
}

const LINKS: &str = include_str!("../../../fixtures/links.json");

#[test]
fn link_fixtures() {
    let spec: Value = serde_json::from_str(LINKS).unwrap();
    let resolver = Resolver::new(strings(&spec["docs"]));
    for case in spec["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let from = case["from"].as_str().unwrap();
        let links = parse_links(case["content"].as_str().unwrap());
        let got: Vec<(&str, &str, Option<String>)> = links
            .iter()
            .map(|l| {
                (
                    l.kind.as_str(),
                    l.target.as_str(),
                    resolver.resolve(l, from),
                )
            })
            .collect();
        let want: Vec<(&str, &str, Option<String>)> = case["links"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| {
                (
                    l["kind"].as_str().unwrap(),
                    l["target"].as_str().unwrap(),
                    l["resolved"].as_str().map(str::to_owned),
                )
            })
            .collect();
        assert_eq!(got, want, "case {name}");
        for link in &links {
            assert_eq!(LinkKind::parse(link.kind.as_str()), Some(link.kind));
        }
    }
}
