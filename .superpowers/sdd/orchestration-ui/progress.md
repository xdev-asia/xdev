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
