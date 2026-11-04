# Ledger: sidebar-git

Task 1: complete (Rust SidebarGroupBy/SidebarSort/CardProps + prefs fields, bindings, api/mock defaults)
Task 2: complete (SourceControlGroupOrder in GitSettings, gitDefaults) - committed together with task 1 (one bindings regeneration).

Notes
- `cargo test -p xdev-desktop`: 421 pass, 1 fail `ptyd::tests::a_dev_build_has_the_binary_next_to_the_app` (needs the ptyd binary built; unrelated).
- Deleted SIDEBAR_SORT_KEY (no readers).
