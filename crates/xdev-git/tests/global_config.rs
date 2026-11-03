//! `global_user_name` against a throwaway global config. The workspace
//! forbids the `unsafe` that `set_var` needs, so each case runs this binary
//! again with `GIT_CONFIG_GLOBAL` pointing at a temp file.

use std::fs;
use std::process::Command;

use xdev_git::global_user_name;

/// Run by `global_user_name_reads_only_the_global_config`; prints what it
/// read so the parent can check it.
#[test]
#[ignore]
fn global_user_name_child() {
    println!("name=[{}]", global_user_name().unwrap().unwrap_or_default());
}

#[test]
fn global_user_name_reads_only_the_global_config() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("gitconfig");
    for (config, want) in [
        ("", "name=[]"),
        ("[user]\n\tname = \"  \"\n", "name=[]"),
        ("[user]\n\tname = Duy Tran \n", "name=[Duy Tran]"),
    ] {
        fs::write(&file, config).unwrap();
        let out = Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "global_user_name_child",
                "--nocapture",
            ])
            .env("GIT_CONFIG_GLOBAL", &file)
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            out.status.success() && stdout.contains(want),
            "{config:?}: {stdout}{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
}
