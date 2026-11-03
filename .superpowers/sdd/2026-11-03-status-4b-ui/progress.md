# Plan 4b — lane ui (feat/status-4b-ui)

Task 0 (R17 + new events + C14 core + C15 core + C18 core + C19): complete (sessions/status layer)
- `StatusState` adds `dead` (only an exit is final) and `lastEvent`. `failed` is now also a non-final turn status
  (`turn-failed`); `Tab.exitCode !== undefined` is "ended" (WorktreeTabs + Sessions use it).
- Escape/Ctrl-C settles `working` and `needs-you` after 500 ms; `interrupt` hook (and turn-done with
  `detail.isInterrupt`) settles at once, quietly. `resume` -> working (ignored after done/failed or a stop).
  `attention` = needs-input. Typing clears a failed turn to idle.
- Stale: per-pane one-shot timer (30 min after the last hook/typing/start of working), only hooked panes.
- `Sessions(api, now, suppressWhenFocused)`; `onAttention(tab, status, detail)`; `Attention` adds "bell";
  `Tab.unreadReason`; `noteBell`, `markRead`, `unreadWorktrees(filter)`.
