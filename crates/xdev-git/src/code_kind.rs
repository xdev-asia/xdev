//! Sorts a changed path into source, test or generated code, so a branch's
//! line count can tell them apart. Plain string checks on a closed rule set.

use serde::{Deserialize, Serialize};

/// What a path holds, as far as its name tells.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodeKind {
    Source,
    Test,
    Generated,
}

/// Lines added and removed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LineCount {
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub added: u64,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub removed: u64,
}

const GENERATED_DIRS: [&str; 9] = [
    "__generated__",
    "__pycache__",
    ".next",
    ".nuxt",
    "coverage",
    "dist",
    "generated",
    "node_modules",
    "vendor",
];

const LOCKFILES: [&str; 18] = [
    "bun.lock",
    "bun.lockb",
    "cargo.lock",
    "composer.lock",
    "flake.lock",
    "gemfile.lock",
    "go.sum",
    "gradle.lockfile",
    "mix.lock",
    "npm-shrinkwrap.json",
    "package-lock.json",
    "packages.lock.json",
    "pipfile.lock",
    "pnpm-lock.yaml",
    "poetry.lock",
    "pubspec.lock",
    "uv.lock",
    "yarn.lock",
];

const TEST_DIRS: [&str; 9] = [
    "__mocks__",
    "__snapshots__",
    "__tests__",
    "cypress",
    "e2e",
    "spec",
    "test",
    "tests",
    "testdata",
];

/// Languages whose test classes are named `FooTest`, `FooTests` or `FooSpec`.
const CLASS_TEST_EXTS: [&str; 9] = [
    "java", "kt", "kts", "scala", "groovy", "cs", "swift", "php", "rb",
];

/// The kind of a repo path with `/` separators. Generated wins over test.
/// Every rule but the class-name one reads the path lowercased.
pub fn code_kind(path: &str) -> CodeKind {
    let lower = path.to_lowercase();
    let (dirs, name) = lower.rsplit_once('/').unwrap_or(("", lower.as_str()));
    let segments = || dirs.split('/');
    if segments().any(|s| GENERATED_DIRS.contains(&s))
        || LOCKFILES.contains(&name)
        || generated_name(name)
    {
        return CodeKind::Generated;
    }
    let original = path.rsplit_once('/').map_or(path, |(_, n)| n);
    if segments().any(|s| TEST_DIRS.contains(&s)) || test_name(name) || class_test_name(original) {
        return CodeKind::Test;
    }
    CodeKind::Source
}

/// `name` holds one of `firsts` directly followed by one of `words` and a `.`.
fn has_marked(name: &str, firsts: &[char], words: &[&str]) -> bool {
    name.char_indices()
        .filter(|(_, c)| firsts.contains(c))
        .any(|(i, c)| {
            let rest = &name[i + c.len_utf8()..];
            words
                .iter()
                .any(|w| rest.strip_prefix(w).is_some_and(|r| r.starts_with('.')))
        })
}

/// `name` holds `.{word}.` with an extension after it.
fn has_dotted(name: &str, word: &str) -> bool {
    let marker = format!(".{word}.");
    name.match_indices(&marker)
        .any(|(i, _)| i + marker.len() < name.len())
}

fn generated_name(name: &str) -> bool {
    name.contains(".generated.")
        || name.contains(".designer.")
        || has_marked(name, &['.', '_'], &["pb", "pb2", "pb2_grpc", "gen"])
        || name.contains("_generated.")
        || [".g.dart", ".freezed.dart", ".snap"]
            .iter()
            .any(|end| name.ends_with(end))
        || ["js", "css", "mjs"].iter().any(|ext| {
            let min = format!(".min.{ext}");
            name.ends_with(&min)
                || name.contains(&format!("{min}."))
                || name.contains(&format!(".{ext}.map"))
        })
}

fn test_name(name: &str) -> bool {
    has_dotted(name, "test")
        || has_dotted(name, "spec")
        || has_marked(name, &['-', '_'], &["test", "tests", "spec", "specs"])
        || (name.starts_with("test_") && name.ends_with(".py"))
        || name == "conftest.py"
}

/// `FooTest.java`, `FooTests.cs`, `FooSpec.scala`: case-sensitive.
fn class_test_name(name: &str) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else {
        return false;
    };
    CLASS_TEST_EXTS.contains(&ext)
        && ["Test", "Tests", "Spec"]
            .iter()
            .any(|end| stem.ends_with(end))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(kind: CodeKind, paths: &[&str]) {
        for path in paths {
            assert_eq!(code_kind(path), kind, "{path}");
        }
    }

    #[test]
    fn code_kind_generated_dirs() {
        check(
            CodeKind::Generated,
            &[
                "src/__generated__/a.ts",
                "pkg/__pycache__/m.pyc",
                ".next/server/page.js",
                "web/.nuxt/app.js",
                "coverage/lcov.info",
                "packages/ui/dist/index.js",
                "api/generated/client.ts",
                "node_modules/x/index.js",
                "vendor/github.com/x/y.go",
                "Vendor/Lib.php",
            ],
        );
    }

    #[test]
    fn code_kind_lockfiles() {
        check(
            CodeKind::Generated,
            &[
                "bun.lock",
                "bun.lockb",
                "Cargo.lock",
                "composer.lock",
                "flake.lock",
                "Gemfile.lock",
                "go.sum",
                "gradle.lockfile",
                "mix.lock",
                "npm-shrinkwrap.json",
                "package-lock.json",
                "packages.lock.json",
                "Pipfile.lock",
                "apps/web/pnpm-lock.yaml",
                "poetry.lock",
                "pubspec.lock",
                "uv.lock",
                "yarn.lock",
            ],
        );
        check(CodeKind::Source, &["my.lock.rs", "cargo.toml", "go.mod"]);
    }

    #[test]
    fn code_kind_generated_names() {
        check(
            CodeKind::Generated,
            &[
                "src/Form1.Designer.cs",
                "src/api.generated.ts",
                "proto/user.pb.go",
                "proto/user_pb2.py",
                "proto/user_pb2_grpc.py",
                "proto/user.pb2.py",
                "src/types.gen.ts",
                "src/types_gen.go",
                "src/schema_generated.rs",
                "lib/model.g.dart",
                "lib/model.freezed.dart",
                "public/app.min.js",
                "public/app.min.css",
                "public/app.min.mjs",
                "public/app.js.map",
                "public/app.css.map",
                "public/app.mjs.map",
                "src/__x/component.snap",
            ],
        );
        check(
            CodeKind::Source,
            &[
                "src/gen.ts",
                "src/generate.ts",
                "src/pbkdf.rs",
                "src/admin.json",
                "src/map.js",
                "src/snapshot.rs",
                "src/origin.ts",
            ],
        );
    }

    #[test]
    fn code_kind_test_dirs() {
        check(
            CodeKind::Test,
            &[
                "src/__mocks__/fs.ts",
                "src/__snapshots__/a.txt",
                "src/__tests__/a.ts",
                "cypress/integration/a.js",
                "e2e/login.ts",
                "spec/models/user.rb",
                "test/a.c",
                "crates/x/tests/it.rs",
                "pkg/testdata/in.json",
                "Tests/A.swift",
            ],
        );
        check(CodeKind::Source, &["src/testing/a.ts", "src/contest/a.ts"]);
    }

    #[test]
    fn code_kind_test_names() {
        check(
            CodeKind::Test,
            &[
                "src/a.test.ts",
                "src/a.spec.tsx",
                "src/A.Test.ts",
                "src/a-test.js",
                "src/a_test.go",
                "src/a-tests.js",
                "src/a_spec.rb",
                "src/a-specs.js",
                "pkg/test_models.py",
                "pkg/conftest.py",
            ],
        );
        check(
            CodeKind::Source,
            &[
                "src/test.ts",
                "src/latest.ts",
                "src/a.test",
                "src/test_models.rs",
                "src/attest.py",
                "src/contest.py",
            ],
        );
    }

    #[test]
    fn code_kind_class_test_names_are_case_sensitive() {
        check(
            CodeKind::Test,
            &[
                "src/FooTest.java",
                "src/FooTests.kt",
                "src/FooSpec.scala",
                "src/FooTest.kts",
                "src/FooTest.groovy",
                "src/FooTests.cs",
                "src/FooTests.swift",
                "src/FooTest.php",
                "src/FooSpec.rb",
            ],
        );
        check(
            CodeKind::Source,
            &["src/footest.java", "src/FOOTEST.java", "src/FooTest.ts"],
        );
    }

    #[test]
    fn code_kind_generated_wins_over_test() {
        check(
            CodeKind::Generated,
            &[
                "tests/__snapshots__/a.test.ts.snap",
                "test/dist/a.test.js",
                "src/a.test.gen.ts",
                "tests/fixtures/package-lock.json",
            ],
        );
    }

    #[test]
    fn code_kind_plain_source() {
        check(
            CodeKind::Source,
            &["src/main.rs", "README.md", "a", "", "dir/", "src/Main.java"],
        );
    }
}
