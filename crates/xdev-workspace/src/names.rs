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

/// The longest slug `slug` makes.
const SLUG_MAX: usize = 48;

/// The most `-n` tries a typed name gets before it is `BranchExists`.
pub const SUFFIX_MAX: u32 = 99;

/// `leaf` for `n` = 1, else `leaf-n`; the leaf is cut so the whole fits the
/// 48-character slug cap, and the suffix stays.
pub fn suffixed(leaf: &str, n: u32) -> String {
    if n <= 1 {
        return leaf.to_owned();
    }
    let tail = format!("-{n}");
    let keep = SLUG_MAX.saturating_sub(tail.len());
    let cut: String = leaf.chars().take(keep).collect();
    // The cut may end on a character git refuses in front of the suffix.
    format!("{}{tail}", cut.trim_end_matches(['/', '.', '-']))
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
        .take(SLUG_MAX);
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

/// Most folders a sparse list holds.
pub const SPARSE_MAX: usize = 50;

/// The cone folders for a sparse checkout, normalized: backslashes as `/`,
/// trimmed, no leading `./` or trailing `/`, duplicates dropped. `None` when
/// one is absolute, has a `..` or `.` part, starts with `-`, holds a control
/// char, or the list is past `SPARSE_MAX`.
pub fn sparse_dirs(dirs: &[String]) -> Option<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for raw in dirs {
        let mut d = raw.trim().replace('\\', "/");
        while let Some(rest) = d.strip_prefix("./") {
            d = rest.to_owned();
        }
        let d = d.trim_end_matches('/');
        if d.is_empty() {
            continue;
        }
        let bad = d.starts_with('-')
            || d.starts_with('/')
            || d.chars().nth(1) == Some(':')
            || d.chars().any(char::is_control)
            || d.split('/').any(|p| matches!(p, "" | "." | ".."));
        if bad {
            return None;
        }
        if !out.iter().any(|o| o == d) {
            out.push(d.to_owned());
        }
    }
    (out.len() <= SPARSE_MAX).then_some(out)
}

/// The branch leaf for work that starts with `prompt`: its first 4 words
/// through the rules of `slug`. Words with no ASCII letter or digit are
/// dropped; `""` when no word is usable.
pub fn from_work(prompt: &str) -> String {
    let words: Vec<String> = prompt
        .split_whitespace()
        // A word with a letter or digit outside ASCII names nothing once that
        // letter is cut out of it.
        .filter(|w| !w.chars().any(|c| !c.is_ascii() && c.is_alphanumeric()))
        .map(|w| {
            let kept: String = w
                .chars()
                .flat_map(char::to_lowercase)
                .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
                .collect();
            kept.trim_matches('-').to_owned()
        })
        .filter(|w| !w.is_empty())
        .take(FROM_WORK_WORDS)
        .collect();
    slug(&words.join("-"))
}

/// The most words of a prompt that `from_work` keeps.
const FROM_WORK_WORDS: usize = 4;

/// A branch prefix as stored or typed: trimmed, without a leading or
/// trailing `/`, and with each `//` run cut to one `/`.
pub fn normalize_prefix(prefix: &str) -> String {
    let mut out = String::new();
    for c in prefix.trim().trim_matches('/').chars() {
        if c == '/' && out.ends_with('/') {
            continue;
        }
        out.push(c);
    }
    out
}

/// Why a normalized prefix cannot start a branch name, or `None` when it
/// can. The rules are git's for a ref part: no control character or space,
/// none of `~ ^ : ? * [ \`, no `..` or `@{`, no leading `-` or trailing
/// `.`, and no part that starts with `.` or ends with `.lock`.
pub fn prefix_issue(prefix: &str) -> Option<PrefixIssue> {
    if prefix
        .chars()
        .any(|c| (c as u32) <= 0x20 || c as u32 == 0x7f)
    {
        return Some(PrefixIssue::Control);
    }
    if prefix.contains(['~', '^', ':', '?', '*', '[', '\\']) {
        return Some(PrefixIssue::Char);
    }
    if prefix.contains("..") || prefix.contains("@{") {
        return Some(PrefixIssue::Sequence);
    }
    if prefix.starts_with('-') || prefix.ends_with('.') {
        return Some(PrefixIssue::Edge);
    }
    if prefix
        .split('/')
        .any(|part| part.starts_with('.') || part.ends_with(".lock"))
    {
        return Some(PrefixIssue::Part);
    }
    None
}

/// What `prefix_issue` found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrefixIssue {
    /// A control character or a space.
    Control,
    /// One of `~ ^ : ? * [ \`.
    Char,
    /// `..` or `@{`.
    Sequence,
    /// A leading `-` or a trailing `.`.
    Edge,
    /// A part that starts with `.` or ends with `.lock`.
    Part,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dirs(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn sparse_dirs_normalizes_and_refuses() {
        assert_eq!(
            sparse_dirs(&dirs(&[" src/ ", "./docs", "a\\b", "src", ""])),
            Some(dirs(&["src", "docs", "a/b"]))
        );
        assert_eq!(sparse_dirs(&[]), Some(vec![]));
        for bad in [
            "..", "a/../b", "/abs", "C:/x", "-rf", "a//b", "a/./b", "a\u{7}",
        ] {
            assert_eq!(sparse_dirs(&dirs(&[bad])), None, "{bad}");
        }
        let many: Vec<String> = (0..51).map(|n| format!("d{n}")).collect();
        assert_eq!(sparse_dirs(&many), None);
        assert!(sparse_dirs(&many[..50]).is_some());
    }

    #[test]
    fn suffixed_counts_from_two_and_keeps_the_suffix_inside_the_cap() {
        assert_eq!(suffixed("feat-one", 1), "feat-one");
        assert_eq!(suffixed("feat-one", 2), "feat-one-2");
        assert_eq!(suffixed("feat-one", 99), "feat-one-99");
        let long = "a".repeat(48);
        let two = suffixed(&long, 2);
        assert_eq!(two.len(), 48);
        assert!(two.ends_with("a-2"));
        let nine = suffixed(&long, 99);
        assert_eq!(nine.len(), 48);
        assert!(nine.ends_with("-99"));
        // A cut that lands on a separator does not leave `.-2` or `/-2`.
        let edge = format!("{}.b", "a".repeat(45));
        assert_eq!(suffixed(&edge, 2), format!("{}-2", "a".repeat(45)));
        // Every result is a slug of itself.
        assert_eq!(slug(&nine), nine);
    }

    #[test]
    fn normalize_prefix_trims_and_tidies_slashes() {
        assert_eq!(normalize_prefix("  feature  "), "feature");
        assert_eq!(normalize_prefix("/team//me/"), "team/me");
        assert_eq!(normalize_prefix("a///b"), "a/b");
        assert_eq!(normalize_prefix(" // "), "");
        assert_eq!(normalize_prefix(""), "");
    }

    #[test]
    fn prefix_issue_follows_git_ref_rules() {
        for ok in ["feature", "team/me", "duy.tran", "a-b_c", "Tên"] {
            assert_eq!(prefix_issue(ok), None, "{ok}");
        }
        let bad = [
            ("a b", PrefixIssue::Control),
            ("a\tb", PrefixIssue::Control),
            ("a\u{7f}", PrefixIssue::Control),
            ("a~b", PrefixIssue::Char),
            ("a^b", PrefixIssue::Char),
            ("a:b", PrefixIssue::Char),
            ("a?b", PrefixIssue::Char),
            ("a*b", PrefixIssue::Char),
            ("a[b", PrefixIssue::Char),
            ("a\\b", PrefixIssue::Char),
            ("a..b", PrefixIssue::Sequence),
            ("a@{b", PrefixIssue::Sequence),
            ("-a", PrefixIssue::Edge),
            ("a.", PrefixIssue::Edge),
            (".a", PrefixIssue::Part),
            ("a/.b", PrefixIssue::Part),
            ("a.lock/b", PrefixIssue::Part),
            ("a/b.lock", PrefixIssue::Part),
        ];
        for (input, want) in bad {
            assert_eq!(prefix_issue(input), Some(want), "{input:?}");
        }
    }

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
    fn from_work_takes_the_first_four_words() {
        assert_eq!(
            from_work("fix the footer usage meter rounding"),
            "fix-the-footer-usage"
        );
        assert_eq!(from_work("  Add   Login\n page  "), "add-login-page");
        assert_eq!(from_work("one"), "one");
    }

    #[test]
    fn from_work_follows_the_slug_rules() {
        // Punctuation goes, an inner dash stays, case folds.
        assert_eq!(
            from_work("Fix: the footer's (usage)!"),
            "fix-the-footers-usage"
        );
        assert_eq!(from_work("add re-try to API"), "add-re-try-to-api");
        // The result is a slug of itself and fits the cap.
        let long = from_work(&"abcdefghijkl ".repeat(6));
        assert!(long.len() <= 48);
        assert_eq!(slug(&long), long);
    }

    #[test]
    fn from_work_drops_non_ascii_and_empty_words() {
        // A word with a letter outside ASCII is dropped whole: cutting the letter
        // out would leave a fragment (`sửa` -> `sa`) that names nothing.
        assert_eq!(from_work("sửa lỗi footer rounding"), "footer-rounding");
        assert_eq!(from_work("a café b"), "a-b");
        assert_eq!(from_work("日本語 だけ"), "");
        assert_eq!(from_work("日本語 fix 😀 the bug now"), "fix-the-bug-now");
        assert_eq!(from_work(""), "");
        assert_eq!(from_work("  ... --- "), "");
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
