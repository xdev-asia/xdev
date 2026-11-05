# Lane orchestration-ui (A11 UI) ledger

Base 0755c35 (B0). Backend tasks (B1-B15) live on feat/orchestration; this lane codes against the B0 contract (api.ts + mockApi.ts).

## Task 1: complete
- xdev-ui branch feat/orchestration-ui: `ActionTile`, icons swap / list-checks / workflow, docs row, demo preview, count 45 -> 46 (README, mcp-smoke, smoke.mjs case, AGENTS.md said 44 and is now 46).
- xdev-ui: 157 tests, build, smoke + mcp-smoke ok. Not pushed.

## Task 2: complete
- Settings > Orchestration (after Agents): `settings/orchestration/{OrchestrationPage,SkillCard,HowToCards}.tsx`, `howTo.ts` (pure: coverageLine, parseDepth, skillState), catalog entries, coverage test page, CSS.
- Dialog uses the app's native `<dialog class="dialog ws-dialog">` pattern (xdev-ui `Dialog` wraps its body in a `<p>`, which cannot hold the prompt `<pre>`).
- All en/vi keys for the page AND the worker strip/toast (`orchestration.worker.*`) were added in this commit; U5/U6 only consume them.
- Edited skill state: Install stays non-force (plan: `orchestrationSkillInstall()`); no force button in v1.
- Shared `.settings-item` unchanged; the page adds `flex-wrap` locally for 360px.
- SettingsView.test indexes updated for the new section.

## Task 3: complete
- `addTab(l, id, pane?, { activate })` and `Sessions.open(..., { id, title, background })`.
- Deviation: a given `title` also sets `renamed: true` so the terminal's own (OSC) title does not replace `worker-<taskId>`.
- `Sessions.open` never selected a worktree; background only keeps the pane's active tab. A worktree with no layout yet gets the tab as its only (active) tab.

## Task 4: complete
- `workspace/orchestrationEvents.ts` (+ test), wired in `WorkspaceShell.tsx` next to `startCliEvents` (same effect, same stop).
- Host is injected (sessions, gate, send, terminal) so tests need no pty. `read-tab` uses `terminalOf(id)` (terminalRegistry); a tab whose Terminal is not mounted answers "" (to check on a real run: background tabs of the active worktree are mounted? not verified).
- Setup stages (the plan names `setup_start`/`setup_wait` without defining them): held by `gate.defer` and not released within `readyTimeoutMs` (or the setup tab failed) -> `setup_wait`; the held launch is cancelled (never opens the tab later). `setup_start` is unused by the UI: the gate has no start step that can fail separately.
- Readiness budget = `readyTimeoutMs` minus the time spent waiting for setup.
- A failed open leaves the already opened tab in place for inspection.
- Same dispatch id twice while in flight = one open, one answer.

## Task 5: complete
- `workspace/workerLifetime.ts` (pure `stripState`, `countdownText` ceil to whole second, `keepOpen` optimistic with re-read), `WorkerStrip.tsx` (xdev-ui `Banner` + secondary Keep open), mounted in `WorktreeTabs.tsx` above the Terminal in every terminal tab pane (it renders nothing without a lifetime; reads once at mount and on `worker-changed` for its tab).
- 1 s tick only while the countdown runs. A finished worker with `closesAtMs = null` (working again) shows the rule text again.
- Open item: the strip does not read `workerAutoClose`; it relies on the backend returning no lifetime / no `closesAtMs` when auto-close is off. With auto-close off the rule text would still say "Closes 2 minutes after it finishes" -> backend should return `null` for the lifetime or the UI should read the setting (decide at merge).
- Banner is warn-toned (xdev-ui has no neutral variant); per plan.

## Task 6: complete
- i18n keys (en + vi, same keys) were added in task 2 (`settings.orchestration.*`) and cover `orchestration.worker.*`; this task adds the open-failure toast (`openFailedToast`, title + stage) wired in `WorkspaceShell`, and relies on the existing parity, `no-hardcoded-colors` and `theme-tokens` tests (green); the new CSS only uses existing vars (`--line`, `--bg-2`, `--text-2`, `--radius-s`).
- Fixed a flaky readiness-budget assertion (clock injected).

## Task 7: skipped (optional)
- No cheap path: the B0 contract has `orchestrationWorkerLifetime(tab)` only (no worker-list / task-to-tab lookup). A `task_<id>` link provider needs a backend lookup such as `orchestration.worker-list`; add after B8 if wanted.

## Review fixes round 1
- Item 1 (0b0afae): `OrchestrationHost.ensureMounted`; the shell marks the worktree visited and reloads when it is not listed. Shell test: a worker in an unvisited worktree is in the mounted tabs.
- Items 2, 3, 8 (3f70efe): `prepareSetup` host hook runs `setupAfterCreate` once per worktree (not for one set up by the UI create flow or with a setup watch), then the gate defers; the agent must be enabled and installed else `terminal_create`; `readTab` drops a lone low surrogate. Limit: if setup asks the person (trust or card), no watch exists yet, so the agent starts without waiting, as in the UI create flow.
- Item 7 (e868c4e): `setup_wait` wording is neutral in en and vi.
- Item 6 (14e126f): `Sessions.open` throws "tab id in use" for a live id.
- Items 4, 11 (4e6e734): `stripState(lifetime, now, { autoClose, running })`; hidden when auto-close is off (the strip reads `orchestrationSettings` at mount and on worker-changed), and when there is no close time and no running agent (`running(tab)` from WorktreeTabs). No backend change needed. Limit: a worker whose agent is idle before its first turn shows no strip until it works.
- Items 9, 10 (5e947b2): secondary "Replace edited copy" (`orchestrationSkillInstall(true)`) in the Edited state; Install stays the one primary button. `patch` queues changes made during a save and applies them on top of the stored value.
- Item 5: skipped (controller).
