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
