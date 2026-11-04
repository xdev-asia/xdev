# Lane activity ledger

Plan: scratchpad plans/2026-11-04-activity.md. Rows: W9, N4, A4, A6, A9.

Task B1: complete (contract: KeepAwake/AwakeView, AgentsSettings fields, power.rs stubs, add_fork, fork param, api/mocks).

Task B2: complete (Awake state machine in power.rs; trait Blocker gained a provided `available()` so a machine with no mechanism reports supported=false before any hold; Default blocker is Unavailable until B3).

Tasks B3+B4: complete, one commit. Deviation: the OS blockers live in a new crate crates/xdev-awake (the desktop crate inherits the workspace `unsafe_code = forbid`; xdev-ipc's pattern of a crate with deny). Linux uses systemd-inhibit around a small sh loop that exits when the app or the inhibitor dies (no `sleep infinity` leak after a crash); macOS caffeinate -i -w <pid>; Windows PowerCreateRequest/PowerSetRequest(SystemRequired). keep_awake_get dropped its unused AppHandle param (TS call unchanged). Cargo clippy prints 25 warnings, none from power.rs/xdev-awake (pre-existing).

## Task U1: complete
- `status/keepAwake.ts`: `startAgentsReport` (edge-only, dispose reports false), `startKeepAwakeReport` over `Sessions`.
- `workspace/KeepAwakeItem.tsx`: `KeepAwakeView` (Popover + RadioGroup, unsupported text) and stateful `KeepAwakeItem`; footer slot `keepAwake` before the version; report started in `WorkspaceShell` beside the notifier.
- i18n `keepAwake.*` in en and vi.

## Task U2: complete
- `agents.keepAwake` (xdev-ui RadioGroup) and `agents.autoTabTitle` (xdev-ui Switch) rows in `AgentsPage.tsx`, one shared `saveAgents` that keeps the other fields; catalog entries with en and vi search words; i18n `settings.agents.keepAwake*` and `settings.agents.autoTabTitle*`.

## Task U3: complete
- `Sessions.setAutoTitle`, `Entry.autoTitle`, `Tab.autoTitled`, snapshot `autoTitled?` (written only when true; restored for attached and resumed tabs). Precedence: hand name > auto title > program title > resume title; `setTitle(null)` returns the auto title. An auto title for a tab named by hand is dropped, not kept behind the name.
- Five test fixtures that build a `Tab` literal got `autoTitled: false`.

## Task U4: complete
- `workspace/autoTabTitle.ts`: `tabTitleFromPrompt` and `startAutoTabTitle` (modelled on `autoRename.ts`); started in `WorkspaceShell`.
- Decision: the setting is read fresh when a tab's lookup starts; a tab found with the setting off counts as tried for this run (same as the branch rename), so turning it on affects tabs that start working afterwards.

## Task U5: complete
- `Sessions.onStatus(listener(tab, from, to, at))`: every status change of an agent tab (exit included), with unsubscribe.
- `activity/feed.ts`: `ActivityFeed` (newest first, cap 200, `done` back to `idle` dropped, stable snapshot, `subscribe`, `follow(sessions)`, `clear`). The shell creates and follows it in U7.
