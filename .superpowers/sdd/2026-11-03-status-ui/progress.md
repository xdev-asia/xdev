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

Task 8: complete
- Store `@/status/statusSettings.ts` (API for the settings lane and anyone else):
  - `STATUS_DEFAULTS: StatusSettings` (all on, `soundFile: null`, `volume: 60`; mirrors the Rust default).
  - `getStatusSettings(): StatusSettings`, the last loaded or set value (defaults until the first load).
  - `setStatusSettings(next: StatusSettings): void` stores a copy and tells subscribers; a value equal to the
    current one is a no-op. The Settings page should call it with what `statusSettingsPut` returned.
  - `loadStatusSettings(api: Pick<Api, "statusSettings">): Promise<StatusSettings>` reads from the desktop and
    sets the store; on failure it keeps the last value and resolves with it.
  - `subscribeStatusSettings(listener): () => void`, `useStatusSettings(): StatusSettings`
    (useSyncExternalStore), `resetStatusSettings()` (tests only).
- Live settings: the settings lane (feat/status-settings) calls `api.statusSettingsPut` itself and does not use the
  store. So the notifier reads the stored settings again (`loadStatusSettings`) before every OS notification,
  sound and badge send. The shell also reloads on a view change, on window focus/blur and on SettingsView
  `onChanged`. The bell follows the store, so it updates on leaving Settings, not on each toggle.
- `workspace/notifier.ts`: `createNotifier({ api, settings, play, now, t })` with `attention(tab, status, names)`,
  `badge(count)`, `lastNotified()`, `takeFocusJump(now)`, `cancelFocusJump()`, `dispose()`.
  `COOLDOWN_MS = 5000`, `BADGE_DEBOUNCE_MS = 200`, `FOCUS_JUMP_MS = 15000`.
- Badge: unread tab count, sent 200 ms after it settles; same value not sent twice; 0 while `badge` is off.
- Bell (`workspace/BellMenu.tsx`): header button with count (`bellCount`: "99+" above 99) and a menu of unread
  tabs, newest `unreadAt` first: glyph, worktree, tab name (title, else profile), state, age. A row jumps to the
  pane: select worktree, show workspace, `front` the tab, focus its xterm textarea. Escape / backdrop close.
  With `bell` off the button is disabled (title `status.bell.off`), without count or list; rows still go bold.
- Seen panes: `WorktreeTabs` gains `onPanes(ids)` (front tab + split partner, terminals only). The shell sends
  `sessions.setSeen` the selected worktree's panes only while the window is focused and visible and the workspace
  view is up; otherwise `[]`.
- Notification click: `api.onStatusNotificationClick` jumps to the pane. R11 fallback: a window `focus` within
  15 s of the newest sent notification jumps there once; a `pointerdown` (capture) in the app first cancels it,
  as does a reported click.
- WorktreeList gets `unread` and `onMarkUnread` (calls `sessions.markUnread`); footer `waiting` = agent tabs in
  needs-you across worktrees.
- Ruling 4 (cooldown): per key `${ptyId}:${status}`, 5 s, covering the OS notification and the sound together.
  The key is taken before the first await, so a burst arriving together is told once. With `os` on, the sound
  plays only when `statusNotify` resolved; with `os` off and `sound` on, it plays alone. sound.ts keeps its 2 s
  floor (unchanged).
- Ruling 5 (body): title = worktree name; body = `status.notify.<state>` with `{name}` = the profile name, or
  the hand-given name when `renamed`. The terminal's OSC title is never used in the notification, because it
  can carry the prompt.
- i18n: `status.notify.{needs-you,done,failed}`, `status.bell.{label,label.one,title,empty,off,row}` (en + vi).
- Tests: WorkspaceShell harness takes the first two effects (`slice(0, 2)`) and no longer counts them from the end.

Open items
- [Unverified] On Windows a toast click only reaches the app while the toast is on screen (backend finding). The
  15 s focus fallback covers the rest. Not checked on a real desktop.
- [Inference] If the person clicks straight into the xDev window (not the toast) within 15 s, window `focus` may
  fire before `pointerdown`, so that click could still jump to the notified pane. Needs a check on a real window.
- The Settings page could call `setStatusSettings(stored)` after `statusSettingsPut` so the bell and badge
  follow each toggle at once (settings lane, not edited here).
- `workspace.header.soon` is no longer used by the bell. It is left in place because other code may still use it.
