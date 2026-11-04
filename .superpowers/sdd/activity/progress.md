# Lane activity ledger

Plan: scratchpad plans/2026-11-04-activity.md. Rows: W9, N4, A4, A6, A9.

Task B1: complete (contract: KeepAwake/AwakeView, AgentsSettings fields, power.rs stubs, add_fork, fork param, api/mocks).

Task B2: complete (Awake state machine in power.rs; trait Blocker gained a provided `available()` so a machine with no mechanism reports supported=false before any hold; Default blocker is Unavailable until B3).

Tasks B3+B4: complete, one commit. Deviation: the OS blockers live in a new crate crates/xdev-awake (the desktop crate inherits the workspace `unsafe_code = forbid`; xdev-ipc's pattern of a crate with deny). Linux uses systemd-inhibit around a small sh loop that exits when the app or the inhibitor dies (no `sleep infinity` leak after a crash); macOS caffeinate -i -w <pid>; Windows PowerCreateRequest/PowerSetRequest(SystemRequired). keep_awake_get dropped its unused AppHandle param (TS call unchanged). Cargo clippy prints 25 warnings, none from power.rs/xdev-awake (pre-existing).
