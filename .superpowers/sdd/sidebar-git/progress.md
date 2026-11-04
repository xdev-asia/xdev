# Ledger: sidebar-git

Task 1: complete (Rust SidebarGroupBy/SidebarSort/CardProps + prefs fields, bindings, api/mock defaults)
Task 2: complete (SourceControlGroupOrder in GitSettings, gitDefaults) - committed together with task 1 (one bindings regeneration).

Notes
- `cargo test -p xdev-desktop`: 421 pass, 1 fail `ptyd::tests::a_dev_build_has_the_binary_next_to_the_app` (needs the ptyd binary built; unrelated).
- Deleted SIDEBAR_SORT_KEY (no readers).

Task 4: complete (sortEntries; sidebarSort.test.ts)
Task 5: complete (groupBy + Section keyed `mode:id`; orderedWorktrees now takes string keys; PrState exported from api.ts)
Task 6: complete (cardModel, WorktreeList draws from prefs; compact CSS). i18n keys for groupBy and sidebar.options.* added here.

## Task 7: complete
- SidebarOptions popover (Group by, Sort by, Layout, 9 card props) next to the filters; tests call the panel with a mocked useState.
- Deviation: Popover and Segmented come from @xdev-asia/ui, so no new xdev-ui part was needed.

## Task 8: complete
- Setting in Settings > Git, catalog entry git.groupOrder, WorktreeChanges draws conflicts, then the chosen order.
- Behaviour change (R5): staged was drawn first before; the default is now changes-first. Flag in the PR text.

## Task 9: complete
- ViewOptions.tree seeded from DiffSettings.fileTree; List/Tree toggle in the review bar; TreeView + pathRows; Save as default writes fileTree.
- No CSS needed: TreeView brings its own styles.

## Task 10: complete
- files/conflictMarkers.ts: parseConflicts and resolveBlock (7-char markers, diff3 base, CRLF kept, unclosed block and stray divider ignored).

## Task 11: complete
- files/conflictDecorations.ts (StateField, parsed on docChanged, accept bar via DOM widget, conflictChange edits the buffer only); added to CodeEditor through a Compartment so labels follow the language.
- Deviation: no FileView test; CodeEditor props are unchanged. Decorations and accept edits are tested on EditorState (no jsdom).

## Task 12: complete
- Gap matrix: none in this worktree (only the generated CHANGELOG mentions the row ids), so nothing to update. [Unverified] it may live outside the repo.
- Gate: pnpm -r typecheck ok; pnpm -r test: xdev-ui 154, desktop 2167 (235 files); desktop build ok; cargo fmt ok; clippy -D warnings ok; cargo test --workspace --no-fail-fast exit 0, no FAILED; export_bindings + packages/bindings diff clean; git status clean, submodule clean at cbb5774.
- PR text must flag: R5 behaviour change. Staged was drawn before Changes; the default is now changes-first (Settings > Git can restore staged-first).
