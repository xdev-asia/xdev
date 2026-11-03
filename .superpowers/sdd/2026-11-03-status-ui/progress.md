# Plan 4 — lane status-ui

Task 6: complete
- Contract used as committed (api.ts `onPtyHook`, `PtyInfo.hooks`, mock `__hook`); no api.ts / mockApi.ts edits.
- `step(state, event, seen = false)`: `seen` is optional so the old timing tests stay as they were.
- `StatusState` adds `caps`, `hooked`, `interruptAt`, `cancelled`; `start(caps)` builds one.
- Caps per launch: `capsFor(cli, hooks)`: claude+hooks = prompt/needsInput/turnDone, codex+hooks = turnDone only,
  else none. Sessions sets them in `noteStarted` from `PtyInfo.hooks`; until then a tab has no caps.
- `Sessions.open(worktree, profileId, account?, cli?)`: `cli` left out = `cliOf(profileId)` (built-in ids
  `claude` / `codex`, else null). Stored on `Tab.cli`.
- `Tab` adds `cli`, `unread`, `unreadAt`, `title`, `renamed`.
- `Sessions` adds `setSeen(ids)`, `markUnread(wt)`, `unread(wt)`, `unreadTabs()`, `noteTitle(id, title)`,
  `noteTitleStatus(id, status)`, `rename(id, name)`, `onAttention(listener)`; `noteInput(id, text?)`.
- Unread / attention only for agent tabs (shells are never news) and not for tabs closed with their worktree.
- The 1 s tick runs only while a working tab waits on quiet (no `turnDone` cap).
- Hook `at` is replaced by the Sessions clock on arrival, so interrupt / debounce windows use one clock.
- Deviation: an idle title does not move a tab out of `needs-you` or `done` (a title cannot undo a hook state).
- groups: needs-you + failed → "needs-you", working → "working", done → "review", idle + exited → "rest".
- Terminal `onInput(text)` now passes the typed text (clean hook point for the interrupt ruling).

Controller rulings (from the reference-app gap report), applied:
- Ruling 1 (precedence, replaces plan R7): a title sets status only while the pane has had no hook event, or its
  launch has no hook caps (`hooked && caps.turnDone` → titles ignored). status.ts `raw()` "title" case.
- Ruling 2 (interrupt): Escape alone (`\x1b`) or Ctrl-C (`\x03`) on a working pane with `caps.turnDone` sets
  `interruptAt`; Sessions arms a 500 ms (`INTERRUPT_MS`) timer. No hook by then → idle + `cancelled`, never
  announced (idle is not an attention state). Decisions beyond the ruling:
  - a `turn-done` hook inside the 500 ms window is the stopped turn ending → idle + cancelled, not done;
  - a late `turn-done` while idle and `cancelled` is ignored; `prompt`, `needs-input` or ordinary typing clear it;
  - `prompt` / `needs-input` inside the window apply normally and cancel the interrupt.
  - Arrow keys (`\x1b[A`, ...) are not Escape alone, so they are not interrupts.
- Ruling 3 (done debounce): a transition to `done` on an unseen agent pane arms a 1500 ms (`DONE_QUIET_MS`) timer;
  unread + `onAttention("done")` fire only if it is still done, unseen and not closing then. Any status change or a
  look cancels it. needs-you and failed announce at once.

Task 7: complete
- `workspace/titles.ts`: `TITLE_RULES` is empty on purpose (no real interactive titles recorded by the spike);
  `titleStatus(cli, title, rules?)` matches per CLI. Terminal gains `onTitle(title)` (xterm `onTitleChange`);
  WorktreeTabs calls `noteTitle` (tab label + tooltip, ellipsis) then `noteTitleStatus` with the rule result.
- `workspace/StatusGlyph.tsx`: `StatusGlyph({ status, label })`. Deviation: it takes the translated `label` from
  the caller instead of calling `useI18n` itself, so rows and tabs call it as a plain function in their loops.
  Text only for needs-you (`?`, `--warn`) and done (check, `--ok`); working is a CSS spinner (`--signal` quarter,
  static under reduced motion), failed / idle a dot (`--danger` / `--text-3`), exited a hollow ring. No stripe.
- Plain shell tabs show no glyph (`status` passed as null for non-agent tabs). The old `.ws-tab-glyph` rules and
  the text glyphs (`○`, `✕`, ...) are gone.
- Unread: tab button `ws-tab-unread` (bold name), aria-label `workspace.tabs.unreadLabel` =
  "{name}, {status}, unread" / "{name}, {status}, chưa xem" (status lower-cased, e.g. ", done, unread").
- WorktreeList: glyph replaces the status dot; new optional props `unread: Record<path, boolean>` and
  `onMarkUnread(wt)`; unread row gets `ws-wt-unread` (bold) and the glyph label `workspace.unreadStatus`;
  "Mark unread" (`workspace.markUnread`) sits in the one menu opened by right-click and the more button, shown
  only when `onMarkUnread` is given (wired in Task 8 by WorkspaceShell).
