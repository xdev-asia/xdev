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

Task 1 (C7 content): complete — title `worktree · tab · state word` (40/80 caps), body message, else error (failed only), else toolName, else empty; 180 cap; whitespace folded; prompt text never used. `status.notify.*` i18n replaced by `status.word.*`.
Task 2 (C9 presence): complete — `status/presence.ts`, 180 s, trusted keydown/pointerdown/wheel only, starts present at mount; `seen` needs focus and presence.
Task 3 (C11 switches): complete — master + onNeedsInput/onDone/onFailed/onBell on the page; `eventOn()` gates notifier, bell list and badge; channel needs its own switch too.
Task 4 (C12 Test): complete — `api.statusNotify` + forced sound; failure shows `settings.notifications.testFailed`.
Task 5 (C14 BEL): complete — Terminal `onBell` -> `Sessions.noteBell`; reason "bell"; notifies only with onBell. Applies to any pane (shell tabs too).
Task 6 (C15 mark read): complete — WorktreeList menu shows Mark read on an unread row.
Task 7 (C16 badge): complete — unread worktrees, 0 when master off.
Task 8 (C18): complete (Sessions.advance; seen pane notifies without unread when the switch is off). No UI switch (not in plan).
Task 9 (C19): complete (see Task 0).
Task 10 (docs): complete — status-and-notifications.md updated, new agent-hooks-cli.md, README row.

Decisions / deviations: failed body falls back message -> error -> toolName (plan: message -> toolName); title cap 80 total with worktree at 40; `failed` is non-final for a turn.
Open: capsFor gives codex only turnDone (PtyInfo.hooks is a boolean, cannot tell a private CODEX_HOME with the full set); Rust status_notify with an empty body unchecked; suppressWhenFocused has no UI switch.
[Unverified]: real OS toast, click and focus behaviour.
