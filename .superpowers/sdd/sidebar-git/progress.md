# Ledger: sidebar-git

Task 1: complete (Rust SidebarGroupBy/SidebarSort/CardProps + prefs fields, bindings, api/mock defaults)
Task 2: complete (SourceControlGroupOrder in GitSettings, gitDefaults) - committed together with task 1 (one bindings regeneration).

Notes
- `cargo test -p xdev-desktop`: 421 pass, 1 fail `ptyd::tests::a_dev_build_has_the_binary_next_to_the_app` (needs the ptyd binary built; unrelated).
- Deleted SIDEBAR_SORT_KEY (no readers).

Task 4: complete (sortEntries; sidebarSort.test.ts)
Task 5: complete (groupBy + Section keyed `mode:id`; orderedWorktrees now takes string keys; PrState exported from api.ts)
Task 6: complete (cardModel, WorktreeList draws from prefs; compact CSS). i18n keys for groupBy and sidebar.options.* added here.
