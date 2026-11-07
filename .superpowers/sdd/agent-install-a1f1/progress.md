# agent-install-a1f1 ledger

## Ruling 3 npm verification (docs_url page checked per row)
- claude: docs_url landing shows no npm command (npm command only on /docs/en/setup) -> None
- codex: github page shows `npm install -g @openai/codex` -> Some
- gemini: github page shows `npm install -g @google/gemini-cli` -> Some
- copilot: docs page shows `npm install -g @github/copilot` -> Some
- opencode: docs_url (/docs/cli/) shows none; /docs/ shows a different package -> None
- qwen: github page shows `npm install -g @qwen-code/qwen-code@latest` -> Some (package without @latest)

## Deviations
- T0 stub commit skipped: single sequential run, contracts land with their real implementation.

Task 0: skipped (see deviations)
Task 1: complete
Task 2: complete (policy-deny case skipped: Policy never denies RunCommand, so no deny fixture exists)
Task 3: complete (bindings regenerated, diff clean)
Task 4: complete
Task 5: complete
Task 6: complete
Task 7: complete (WorkspaceShell.test.tsx not extended: no existing case drives SettingsView props; manual M2 left)

## Deviations
- watchInstall takes a 5th arg `agentId` (before onView): the view check needs the profile id.
- T0 stubs skipped (see above); install_for(remote, ...) helper extracted so the remote refusal is unit-tested.
- opencode and claude stay None (docs_url page does not show npm).
