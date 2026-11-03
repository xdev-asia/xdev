use std::collections::HashSet;

/// Short lowercase nouns, valid as branch names and folder names.
const WORDS: [&str; 48] = [
    "oak", "elm", "ash", "fir", "yew", "pine", "birch", "cedar", "maple", "willow", "aspen",
    "alder", "hazel", "larch", "rowan", "beech", "moss", "fern", "river", "brook", "creek",
    "delta", "fjord", "lake", "marsh", "pond", "reef", "tide", "heron", "finch", "wren", "swift",
    "robin", "raven", "crane", "egret", "ibis", "kite", "lark", "owl", "stork", "tern", "swan",
    "quail", "dove", "gull", "hawk", "jay",
];

/// The first word not in `taken`, counting on from `seed % 48`. When every
/// word is taken the words come round again with `-2`, then `-3`.
pub fn pick(taken: &HashSet<String>, seed: u64) -> String {
    let len = WORDS.len();
    let start = (seed % len as u64) as usize;
    (1u32..)
        .flat_map(|n| (0..len).map(move |i| (n, WORDS[(start + i) % len])))
        .map(|(n, word)| match n {
            1 => word.to_owned(),
            _ => format!("{word}-{n}"),
        })
        .find(|name| !taken.contains(name))
        .unwrap_or_default()
}

/// A branch name from what the user typed: lowercase, spaces as `-`, only
/// `[a-z0-9._/-]`, no leading `-`, `.` or `/`, at most 48 characters. No
/// `//` or `..`, and no trailing `/`, `.`, `-` or `.lock`, which git refuses.
pub fn slug(name: &str) -> String {
    let mut out = String::new();
    let kept = name
        .chars()
        .flat_map(char::to_lowercase)
        .map(|c| if c.is_whitespace() { '-' } else { c })
        .filter(|c| matches!(c, 'a'..='z' | '0'..='9' | '.' | '_' | '/' | '-'))
        .skip_while(|c| matches!(c, '-' | '.' | '/'))
        .take(48);
    for c in kept {
        if matches!(c, '/' | '.') && out.ends_with(c) {
            continue;
        }
        out.push(c);
    }
    loop {
        let trimmed = out.trim_end_matches(['/', '.', '-']);
        let trimmed = trimmed.strip_suffix(".lock").unwrap_or(trimmed);
        if trimmed.len() == out.len() {
            return out;
        }
        out.truncate(trimmed.len());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_starts_at_the_seed_and_skips_taken_words() {
        let none = HashSet::new();
        assert_eq!(pick(&none, 0), WORDS[0]);
        assert_eq!(pick(&none, 50), WORDS[2]);
        let taken: HashSet<String> = [WORDS[2].to_owned()].into();
        assert_eq!(pick(&taken, 50), WORDS[3]);
    }

    #[test]
    fn pick_suffixes_when_every_word_is_taken() {
        let mut taken: HashSet<String> = WORDS.iter().map(|w| (*w).to_owned()).collect();
        assert_eq!(pick(&taken, 0), "oak-2");
        taken.insert("oak-2".to_owned());
        assert_eq!(pick(&taken, 0), "elm-2");
    }

    #[test]
    fn words_are_unique_and_plain() {
        let set: HashSet<_> = WORDS.iter().collect();
        assert_eq!(set.len(), WORDS.len());
        assert!(
            WORDS
                .iter()
                .all(|w| w.chars().all(|c| c.is_ascii_lowercase()))
        );
    }

    #[test]
    fn slug_lowercases_dashes_and_drops_the_rest() {
        assert_eq!(slug("Fix login"), "fix-login");
        assert_eq!(slug("feat/New thing: 2"), "feat/new-thing-2");
        assert_eq!(slug("--..x"), "x");
        assert_eq!(slug("..."), "");
        assert_eq!(slug(&"a".repeat(60)).len(), 48);
    }

    #[test]
    fn slug_never_ends_in_a_name_git_refuses() {
        let tmp = tempfile::tempdir().unwrap();
        let ok = std::process::Command::new("git")
            .current_dir(tmp.path())
            .args(["init", "-q"])
            .status()
            .unwrap();
        assert!(ok.success());
        let repo = xdev_git::Repo::discover(tmp.path()).unwrap();

        let slash_at_48 = format!("{}/{}", "a".repeat(47), "b".repeat(12));
        assert_eq!(slash_at_48.chars().nth(47), Some('/'));
        let cases = [
            (slash_at_48.as_str(), "a".repeat(47)),
            ("feature.lock", "feature".to_owned()),
            ("x.lock.lock", "x".to_owned()),
            ("x-.lock/", "x".to_owned()),
            ("a//b..c", "a/b.c".to_owned()),
            ("/x", "x".to_owned()),
        ];
        for (input, want) in cases {
            let got = slug(input);
            assert_eq!(got, want, "{input}");
            assert!(repo.valid_branch_name(&got).unwrap(), "{input} -> {got}");
        }
        let ends = format!("{}x.lock", "a".repeat(43));
        assert!(repo.valid_branch_name(&slug(&ends)).unwrap());
    }
}
