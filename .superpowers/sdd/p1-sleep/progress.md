# Lane p1-sleep (integ/p1-sleep)

- Step 1: xdev-ui integ/p1-sleep = d27a59e + merge of b/p1-rest (206de4d). Conflicts: docs/design-system.md Inputs row (union incl. FontField + SearchPicker), i18n-labels.test.ts (both tests). Counts 46 -> 47 in README and scripts/mcp-smoke.mjs.
- Task 2: complete. Merge feat/p1-rest (conflict: WorkspaceShell.tsx api import = union). Minors: fork path drops skipped record key; made_insert errors when the fetched branch does not resolve (both in one commit); discard args asserted.
- Task 3: complete. Merge feat/sleep-search (pin unchanged, same as merge base). Settings: AgentsSettings holds keepAwake, autoTabTitle, autoSleep, sleepAfterMin, sessionSearch; agents_settings_put = power::put_agents(settings.clamped()). Minors: Sessions.sleepable; poll status until first build; remove_with_retry (5 x 100 ms) + UI re-read on clear failure.
- Open: cancel-flag idea for the index build skipped. read_counts still runs outside the INDEX lock (retry covers it).
- Needs Windows check: clear while the settings page polls status (retry path).
