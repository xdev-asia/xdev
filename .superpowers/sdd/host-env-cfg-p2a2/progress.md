# host-env-cfg-p2a2 ledger
Base: origin/batch/22 2dc822ac (plan says 41ca7bf3; instructed to use this branch, no rebase).
Task 0: complete (baseline green: xdev-ssh remote_cmd 5 passed; desktop filters 117 passed)
Task 1: complete (remote_cmd tests 9 passed)
Task 2: complete (launch_values; deviation: validates only shell+env, not label/history, so a bad history/days never blocks a launch)
Task 3: complete (launch_spec calls launch_values before hub.ensure; refused entry asserts rig spawn count 0)
Task 4: complete (wrap computes merge_env once; shell branch passes env)
Task 5: complete (ssh_tab_host + pty_spawn wiring + source-scan guard test pty_spawn_gives_a_saved_host_tab_its_host_values)
Task 6: complete, deviation: HostSettings.env doc comment in settings.rs NOT changed (Do-NOT-touch; its doc comment is exported into packages/bindings HostSettings.ts, would change a binding). RemoteSpec.host_env and wrap docs updated.
Gate: cargo test -p xdev-ssh remote_cmd 9 passed; desktop filtered 127 passed (incl. local_only_commands_are_guarded, main_webview_is_granted); fmt ok; clippy -D warnings ok; export_bindings ok and no diff after revert.
Not run: section 6 manual checks (need real SSH host) - not checked by hand.
FU-A not done (as instructed).
