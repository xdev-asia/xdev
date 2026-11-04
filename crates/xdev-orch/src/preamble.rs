//! The text a dispatched worker starts with: who it is, which commands it
//! has, what to do when it is done and, when it may start workers of its
//! own, how. Agent-facing English only.

use crate::error::OrchError;

/// The most a task spec may weigh before it no longer fits a prompt.
pub const SPEC_BUDGET: usize = 64 * 1024;

/// What a preamble is built from.
#[derive(Debug, Clone)]
pub struct PreambleInput<'a> {
    pub run: &'a str,
    pub task: &'a str,
    pub dispatch: &'a str,
    pub spec: &'a str,
    /// This worker's depth: a worker the coordinator starts is at 1.
    pub depth: u32,
    pub max_depth: u32,
    /// How the CLI is invoked (`xdev`).
    pub cli: &'a str,
}

/// Builds the preamble, ending in the task spec.
pub fn build(i: &PreambleInput<'_>) -> Result<String, OrchError> {
    if i.spec.len() > SPEC_BUDGET {
        return Err(OrchError::new(
            "worker_prompt_too_large",
            format!(
                "the task spec is {} bytes; a worker prompt takes at most {SPEC_BUDGET}",
                i.spec.len()
            ),
        ));
    }
    let cli = i.cli;
    let to = format!("run:{}", i.run);
    let mut out = String::new();
    out.push_str(&format!(
        "You are a dispatched worker in an xDev orchestration run.\n\
         Run: {run}  Task: {task}  Dispatch: {dispatch}  Depth: {depth} of {max}\n\
         Do only the task below. Your coordinator is {to}; you are dispatch:{dispatch}.\n\n",
        run = i.run,
        task = i.task,
        dispatch = i.dispatch,
        depth = i.depth,
        max = i.max_depth,
    ));
    out.push_str(&format!(
        "=== CLI COMMANDS ===\n\
         {cli} orchestration check\n    Read your mail. Run it when you start and whenever you are told mail is waiting.\n\
         {cli} orchestration send --to {to} --type status --subject \"<short>\" --body \"<text>\"\n    Report progress. Use --type question for a question you need answered.\n\
         {cli} orchestration ask --question \"<text>\" [--option <choice> ...]\n    Ask the person. It returns at once; then end your turn. The answer arrives as mail.\n\
         {cli} orchestration reply --id <message> --body \"<text>\"\n    Answer a message sent to you.\n\
         {cli} orchestration send --to {to} --type worker_done --outcome succeeded|failed --subject \"<short>\" --body \"<what you did>\"\n    Report that you are finished.\n\n"
    ));
    out.push_str(
        "=== AFTER YOU SEND worker_done ===\n\
         Stop. Run no more commands, do not poll and do not wait for a reply. \
         xDev closes your tab shortly after, unless the person keeps it open.\n\n",
    );
    if i.depth < i.max_depth {
        out.push_str(&format!(
            "=== SUB-DISPATCH ===\n\
             You may split your task and start workers of your own (depth {next} of {max}):\n\
             {cli} orchestration worker-start --spec \"<what the worker does>\"\n\
             Then end your turn. xDev wakes you when a worker reports; do not poll. \
             Their reports arrive as mail to dispatch:{dispatch}.\n\n",
            next = i.depth + 1,
            max = i.max_depth,
            dispatch = i.dispatch,
        ));
    }
    out.push_str("=== TASK ===\n");
    out.push_str(i.spec);
    if !out.ends_with('\n') {
        out.push('\n');
    }
    Ok(plain(&out))
}

/// `text` with CRLF made LF and every control character but newline and tab
/// dropped (a lone CR too), so a spec can neither end a bracketed paste nor
/// press Enter half way.
fn plain(text: &str) -> String {
    text.replace("\r\n", "\n")
        .chars()
        .filter(|&c| c == '\n' || c == '\t' || !c.is_control())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn input(depth: u32, max_depth: u32, spec: &str) -> PreambleInput<'_> {
        PreambleInput {
            run: "run_a1",
            task: "task_b2",
            dispatch: "disp_c3",
            spec,
            depth,
            max_depth,
            cli: "xdev",
        }
    }

    /// Compares with `tests/golden/<name>`; `XDEV_UPDATE_GOLDEN=1` rewrites it.
    fn golden(name: &str, got: &str) {
        let path: PathBuf = [env!("CARGO_MANIFEST_DIR"), "tests", "golden", name]
            .iter()
            .collect();
        if std::env::var_os("XDEV_UPDATE_GOLDEN").is_some() {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, got).unwrap();
        }
        let want = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("{path:?}: {e}"))
            .replace("\r\n", "\n");
        assert_eq!(
            got, want,
            "{name} differs; XDEV_UPDATE_GOLDEN=1 rewrites it"
        );
    }

    #[test]
    fn a_worker_that_may_dispatch_gets_all_four_sections() {
        let got = build(&input(1, 3, "Add the flag.\nTest it.")).unwrap();
        golden("preamble_with_sub_dispatch.txt", &got);
        for h in [
            "=== CLI COMMANDS ===",
            "=== AFTER YOU SEND worker_done ===",
            "=== SUB-DISPATCH ===",
            "=== TASK ===",
        ] {
            assert!(got.contains(h), "{h}");
        }
    }

    #[test]
    fn a_worker_at_the_depth_limit_gets_no_sub_dispatch_section() {
        let got = build(&input(3, 3, "Add the flag.")).unwrap();
        golden("preamble_at_max_depth.txt", &got);
        assert!(!got.contains("SUB-DISPATCH"));
        assert!(got.ends_with("=== TASK ===\nAdd the flag.\n"));
    }

    #[test]
    fn the_spec_budget_is_64_kib() {
        let ok = "x".repeat(SPEC_BUDGET);
        assert!(build(&input(1, 2, &ok)).is_ok());
        let big = "x".repeat(SPEC_BUDGET + 1);
        let e = build(&input(1, 2, &big)).unwrap_err();
        assert_eq!(e.code, "worker_prompt_too_large");
    }

    #[test]
    fn control_characters_never_reach_the_terminal() {
        let spec = "a\u{1b}[201~rm -rf /\r\nb\tc\u{0}\u{7}\u{7f}d\re";
        let got = build(&input(1, 1, spec)).unwrap();
        assert!(
            got.ends_with("=== TASK ===\na[201~rm -rf /\nb\tcde\n"),
            "{got:?}"
        );
        assert!(
            !got.chars()
                .any(|c| c.is_control() && c != '\n' && c != '\t'),
            "{got:?}"
        );
    }
}
