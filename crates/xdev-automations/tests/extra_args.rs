use xdev_agent::Cli;
use xdev_automations::{ExtraArgsError as E, parse_extra_args};

fn claude(t: &str) -> Result<Vec<String>, E> {
    parse_extra_args(Some(Cli::Claude), t)
}
fn codex(t: &str) -> Result<Vec<String>, E> {
    parse_extra_args(Some(Cli::Codex), t)
}
fn v(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

#[test]
fn nothing_to_add_is_fine_for_any_agent() {
    assert_eq!(claude("  "), Ok(vec![]));
    assert_eq!(parse_extra_args(None, ""), Ok(vec![]));
    assert_eq!(parse_extra_args(Some(Cli::Gemini), ""), Ok(vec![]));
}

#[test]
fn only_claude_and_codex_take_extras() {
    assert_eq!(
        parse_extra_args(Some(Cli::Gemini), "--model x"),
        Err(E::Unsupported)
    );
    assert_eq!(parse_extra_args(None, "--model x"), Err(E::Unsupported));
}

#[test]
fn claude_takes_a_model_an_effort_and_directories() {
    assert_eq!(
        claude("--model opus --effort high"),
        Ok(v(&["--model", "opus", "--effort", "high"]))
    );
    assert_eq!(
        claude("--model=claude-opus-4-5 --effort=max"),
        Ok(v(&["--model", "claude-opus-4-5", "--effort", "max"]))
    );
    assert_eq!(
        claude("--add-dir ../a --add-dir /b/c"),
        Ok(v(&["--add-dir", "../a", "--add-dir", "/b/c"]))
    );
    assert_eq!(
        claude("--effort low\t--model\nsonnet").unwrap_err(),
        E::ControlCharacters
    );
}

#[test]
fn a_model_and_an_effort_may_appear_once() {
    assert_eq!(claude("--model a --model b"), Err(E::ModelRepeated));
    assert_eq!(claude("--effort low --effort high"), Err(E::EffortRepeated));
}

#[test]
fn an_effort_has_a_fixed_set_of_values() {
    for ok in ["low", "medium", "high", "xhigh", "max"] {
        assert!(claude(&format!("--effort {ok}")).is_ok(), "{ok}");
    }
    assert_eq!(
        claude("--effort extreme"),
        Err(E::ValueNotAllowed {
            option: "--effort".into(),
            value: "extreme".into()
        })
    );
}

#[test]
fn a_model_name_is_a_plain_word() {
    assert_eq!(
        claude("--model -x"),
        Err(E::MissingValue {
            option: "--model".into()
        })
    );
    assert_eq!(
        claude("--model a,b"),
        Err(E::ValueNotAllowed {
            option: "--model".into(),
            value: "a,b".into()
        })
    );
}

#[test]
fn an_option_without_a_value_is_refused() {
    assert_eq!(
        claude("--model"),
        Err(E::MissingValue {
            option: "--model".into()
        })
    );
    assert_eq!(
        claude("--add-dir --model x"),
        Err(E::MissingValue {
            option: "--add-dir".into()
        })
    );
    assert_eq!(
        claude("--model="),
        Err(E::MissingValue {
            option: "--model".into()
        })
    );
}

#[test]
fn other_options_and_loose_words_are_refused() {
    assert_eq!(
        claude("--dangerously-skip-permissions"),
        Err(E::OptionNotAllowed {
            option: "--dangerously-skip-permissions".into()
        })
    );
    assert_eq!(
        claude("-m opus"),
        Err(E::OptionNotAllowed {
            option: "-m".into()
        })
    );
    assert_eq!(
        claude("opus"),
        Err(E::NotAnOption {
            token: "opus".into()
        })
    );
    assert_eq!(
        claude("--model opus extra"),
        Err(E::NotAnOption {
            token: "extra".into()
        })
    );
}

#[test]
fn the_terminator_is_refused() {
    assert_eq!(claude("--model opus --"), Err(E::Terminator));
    assert_eq!(claude("-- rm -rf"), Err(E::Terminator));
}

#[test]
fn shell_syntax_and_control_characters_are_refused() {
    for bad in [
        "--model a;b",
        "--model a|b",
        "--model $HOME",
        "--model `x`",
        "--model a&b",
        "--add-dir ~/x",
        "--model 'a'",
        "--model a>b",
    ] {
        assert!(matches!(claude(bad), Err(E::ShellSyntax { .. })), "{bad}");
    }
    assert_eq!(claude("--model a\u{7}b"), Err(E::ControlCharacters));
    assert_eq!(claude("--model a\nb"), Err(E::ControlCharacters));
}

#[test]
fn the_text_is_at_most_4096_bytes() {
    let ok = format!("--add-dir {}", "a".repeat(4096 - "--add-dir ".len()));
    assert_eq!(ok.len(), 4096);
    assert!(claude(&ok).is_ok());
    assert_eq!(claude(&format!("{ok}a")), Err(E::TooLarge));
}

#[test]
fn codex_takes_a_model_and_a_reasoning_effort() {
    assert_eq!(codex("-m gpt-5.5"), Ok(v(&["-m", "gpt-5.5"])));
    assert_eq!(
        codex("--model gpt-5.5 -c model_reasoning_effort=high"),
        Ok(v(&[
            "--model",
            "gpt-5.5",
            "-c",
            "model_reasoning_effort=high"
        ]))
    );
    assert_eq!(
        codex("--config=model_reasoning_effort=low"),
        Ok(v(&["--config", "model_reasoning_effort=low"]))
    );
}

#[test]
fn codex_config_is_only_for_the_reasoning_effort() {
    assert_eq!(
        codex("-c sandbox_mode=danger-full-access"),
        Err(E::ValueNotAllowed {
            option: "-c".into(),
            value: "sandbox_mode=danger-full-access".into()
        })
    );
    assert_eq!(
        codex("-c model_reasoning_effort="),
        Err(E::ValueNotAllowed {
            option: "-c".into(),
            value: "model_reasoning_effort=".into()
        })
    );
    assert_eq!(codex("-m a -m b"), Err(E::ModelRepeated));
    assert_eq!(codex("-m a --model b"), Err(E::ModelRepeated));
    assert_eq!(
        codex("-c model_reasoning_effort=low -c model_reasoning_effort=high"),
        Err(E::EffortRepeated)
    );
    assert_eq!(
        codex("--add-dir x"),
        Err(E::OptionNotAllowed {
            option: "--add-dir".into()
        })
    );
    assert_eq!(
        codex("--effort high"),
        Err(E::OptionNotAllowed {
            option: "--effort".into()
        })
    );
}
