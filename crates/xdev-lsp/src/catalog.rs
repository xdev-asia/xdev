//! Which languages have a server, which programs serve each, and in what
//! order they are tried.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum LspLanguage {
    Typescript,
    Rust,
    Python,
    Go,
    Csharp,
}

impl LspLanguage {
    pub const ALL: [LspLanguage; 5] = [
        LspLanguage::Typescript,
        LspLanguage::Rust,
        LspLanguage::Python,
        LspLanguage::Go,
        LspLanguage::Csharp,
    ];

    /// The serde name, for logs and settings.
    pub fn as_str(self) -> &'static str {
        match self {
            LspLanguage::Typescript => "typescript",
            LspLanguage::Rust => "rust",
            LspLanguage::Python => "python",
            LspLanguage::Go => "go",
            LspLanguage::Csharp => "csharp",
        }
    }
}

/// The programs that serve `lang`, best first, with their arguments.
pub fn candidates(lang: LspLanguage) -> &'static [(&'static str, &'static [&'static str])] {
    match lang {
        LspLanguage::Typescript => &[("typescript-language-server", &["--stdio"])],
        LspLanguage::Rust => &[("rust-analyzer", &[])],
        LspLanguage::Python => &[("pyright-langserver", &["--stdio"]), ("pylsp", &[])],
        LspLanguage::Go => &[("gopls", &[])],
        LspLanguage::Csharp => &[
            ("csharp-ls", &[]),
            ("OmniSharp", &["-lsp"]),
            ("omnisharp", &["-lsp"]),
        ],
    }
}

/// The arguments `program` takes for `lang`; empty for a program not listed.
pub fn args_of(lang: LspLanguage, program: &str) -> &'static [&'static str] {
    candidates(lang)
        .iter()
        .find(|(name, _)| *name == program)
        .map_or(&[], |(_, args)| *args)
}

/// The server language of an editor language id.
pub fn language_of(language_id: &str) -> Option<LspLanguage> {
    match language_id {
        "typescript" | "typescriptreact" | "javascript" | "javascriptreact" => {
            Some(LspLanguage::Typescript)
        }
        "rust" => Some(LspLanguage::Rust),
        "python" => Some(LspLanguage::Python),
        "go" => Some(LspLanguage::Go),
        "csharp" => Some(LspLanguage::Csharp),
        _ => None,
    }
}

/// For each language, the first candidate `find` locates: its name and path.
pub fn detect(
    find: &dyn Fn(&str) -> Option<PathBuf>,
) -> Vec<(LspLanguage, Option<(String, PathBuf)>)> {
    LspLanguage::ALL
        .iter()
        .map(|&lang| {
            let found = candidates(lang)
                .iter()
                .find_map(|(name, _)| find(name).map(|path| ((*name).to_owned(), path)));
            (lang, found)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_falls_back_to_the_next_candidate() {
        let find = |name: &str| match name {
            "pylsp" | "rust-analyzer" => Some(PathBuf::from(format!("/bin/{name}"))),
            _ => None,
        };
        let found = detect(&find);
        assert_eq!(found.len(), LspLanguage::ALL.len());
        let of = |lang| {
            found
                .iter()
                .find(|(l, _)| *l == lang)
                .and_then(|(_, f)| f.clone())
        };
        assert_eq!(
            of(LspLanguage::Python),
            Some(("pylsp".into(), PathBuf::from("/bin/pylsp")))
        );
        assert_eq!(
            of(LspLanguage::Rust),
            Some(("rust-analyzer".into(), PathBuf::from("/bin/rust-analyzer")))
        );
        assert_eq!(of(LspLanguage::Typescript), None);
        assert_eq!(of(LspLanguage::Csharp), None);
    }

    #[test]
    fn the_first_candidate_wins() {
        let found = detect(&|name| Some(PathBuf::from(name)));
        let python = found.iter().find(|(l, _)| *l == LspLanguage::Python);
        assert_eq!(
            python
                .and_then(|(_, f)| f.as_ref())
                .map(|(n, _)| n.as_str()),
            Some("pyright-langserver")
        );
    }

    #[test]
    fn language_ids_map_to_servers() {
        for id in [
            "typescript",
            "typescriptreact",
            "javascript",
            "javascriptreact",
        ] {
            assert_eq!(language_of(id), Some(LspLanguage::Typescript));
        }
        assert_eq!(language_of("rust"), Some(LspLanguage::Rust));
        assert_eq!(language_of("csharp"), Some(LspLanguage::Csharp));
        assert_eq!(language_of("markdown"), None);
    }

    #[test]
    fn args_and_names() {
        assert_eq!(
            args_of(LspLanguage::Typescript, "typescript-language-server"),
            ["--stdio"]
        );
        assert_eq!(args_of(LspLanguage::Csharp, "omnisharp"), ["-lsp"]);
        assert!(args_of(LspLanguage::Go, "other").is_empty());
        assert_eq!(
            serde_json::to_value(LspLanguage::Csharp).unwrap(),
            serde_json::json!("csharp")
        );
        for lang in LspLanguage::ALL {
            assert_eq!(serde_json::to_value(lang).unwrap(), lang.as_str());
        }
    }
}
