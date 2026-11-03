# Plan 4b, lane B (backend) — progress

Worktree `wt/status-4b-backend`, branch `feat/status-4b-backend` from `feat/status-notifications` @ 4910b8b.

## Task 1: complete (C1 claude events + version gate)
- `crates/xdev-agent/src/version.rs`: `CliVersion::parse` + `cli_version(program)`, `--version` run once per
  (program path, file mtime) per process, 5 s timeout, no console window.
- `hook_args(cli, xdev, version)`: claude gets the 8 C1 events with `"timeout": 10` (number) on >= 2.1.317;
  unknown/older versions get only `UserPromptSubmit` + `Stop`. `Notification` dropped.
- [Unverified] the first claude version supporting PermissionRequest, Elicitation, ElicitationResult,
  PreToolUse(AskUserQuestion), PostToolUse, StopFailure: gate set at 2.1.317 (the only version checked).
- Matchers: `*` on PermissionRequest/Elicitation/ElicitationResult/PostToolUse, `AskUserQuestion` on
  PreToolUse, none on UserPromptSubmit/StopFailure/Stop (same as the spike's settings).
- `Launch::add_hooks` probes the version; `add_hooks_with(xdev, version)` for tests/callers that know it.
- needs-input idempotent: `append_hook_detail` drops a `needs-input` within 2000 ms (`REPEAT_MS`) of a
  `needs-input` that is the file's last line. Decision: a time window, not "any repeat", so a second
  permission prompt after a denied one (no PostToolUse in between) still shows.
- `append_hook_detail` also clips detail strings to DETAIL_MAX and keeps the line < 4096 bytes (R5).

## Task 2: complete (C6 bounded stdin in `xdev agent-hook`)
- CLI `Event` covers all 7 HookEvent values (kebab on the command line).
- Hook JSON: codex `notify` payload = last argument when it parses as a JSON object; otherwise stdin,
  skipped when a terminal, read up to 64 KiB, waited on at most 1 s (an over-cap input is cut, fails to
  parse, so no detail). Junk/non-object input still writes the bare line.
- Whitelist: `tool_name`, `message` (`last_assistant_message` stands in on turn-done), `is_interrupt`,
  `error`; notify: only `last-assistant-message`. Never `prompt`, `input-messages`, `tool_input`, `cwd`,
  `transcript_path`.
- Notify turn filter: `UserPromptSubmit` (codex hooks) stores `turn_id` in `<local>/hooks/<id>.turn`
  (the desktop watcher reads only `*.jsonl`, so it is ignored there); a notify whose `turn-id` differs
  is dropped. No `.turn` file (old codex, notify only) → every payload counts.
- Interpretation: "prints nothing" = stdout. A failure (bad/missing XDEV_PTY_ID, unknown event) still
  prints one stderr line, as before 4b and as the existing tests require; exit is always 0.

## Task 3: complete (C10 codex private home)
- `crates/xdev-agent/src/codex_home.rs`: `prepare_codex_home(data_dir, account, real_home, xdev, version)`
  builds `<data_dir>/codex-home/<account or default>/` (an account literally named `default` gets
  `account-default`, so it never shares the system-default home). Never under %TEMP% in production
  (data_dir); tests use temp dirs only and assert the fake real home is byte-for-byte untouched.
- hooks.json: UserPromptSubmit→prompt, PermissionRequest→needs-input, PostToolUse→resume,
  Stop→turn-done (timeout 10), Interrupt→interrupt (timeout 3, only from 0.150). No matchers.
  Private home only from codex 0.136; unknown/older version → `-c notify=` only (as 4a).
- config.toml: deviation from "holds only hooks/trust": it is the real home's config.toml, merged, then
  `[features] hooks = true` (and `codex_hooks` removed), plus `[hooks.state."<key>"]` with
  `enabled = true` + `trusted_hash` for each hook in both `\` and `/` key forms (Windows). Why: CODEX_HOME
  replaces the whole home, so without the merge the person's model, MCP servers and profiles would vanish
  in xDev panes. `[projects]` trust that codex writes into the private copy is kept across relaunches.
  A real config.toml that does not parse → setup fails → notify fallback. Written atomically.
- Trust hash: local port only, `sha256:` + sha256 of `{"event_name":<snake label>,"hooks":[{"async":false,
  "command":…,"timeout":…,"type":"command"}]}` (sorted keys, compact). [Unverified]: no test vectors
  (0.129/0.140/0.159.3) were available — the spike's `codex_trust.py` and the reference sources are not on
  this machine; `event_name` = snake label is a guess; Windows key path normalization is a guess.
  Deviation: the `codex app-server` `hooks/list` currentHash probe is NOT implemented (would spawn the real
  CLI under the person's account per launch with an untested protocol). Mitigation: `notify` stays on with
  the private home, so a skipped (untrusted) Stop still yields turn-done; `xdev agent-hook` drops a notify
  whose turn-id `Stop` already reported (`<id>.done` side file) or that is not the last prompt's turn.
- auth.json: hard link to the real file; before each launch the identity is checked (same volume/file
  index on Windows via winapi-util with a no-access handle, dev/inode on Unix — content never read). If it
  is no longer the same file, the private file is renamed to `auth.json.unlinked-<ms>` (never deleted) and
  re-linked. Deviation: the check is "same file and ≥2 links", not "link count == 2" — a third name (the
  spike's link in the Recycle Bin) is not a broken link, and `== 2` would re-link on every launch. No real
  auth.json, or a link across drives → setup fails → notify fallback (never a logged-out private home).
- sessions/: junction (`mklink /J`, no window) then `symlink_dir` on Windows, symlink on Unix. Skipped if the
  real sessions dir is missing (nothing is created in the real home) or a private one already exists.
- Windows hook command: bare `/` path when `^[A-Za-z0-9_.:/~-]+$`, else
  `C:\Windows\System32\cmd.exe --% /d /v:off /c @"path" agent-hook <ev>` [Unverified, not run]. Unix:
  single-quoted path.
- `Launch::add_hooks(xdev, data_dir)` (signature gained `data_dir`; `add_hooks_with(xdev, data_dir,
  version)`): the real home is the launch's CODEX_HOME (account/profile env, case-insensitive on Windows),
  else `xdev_ai::codex_home(None)`; on success CODEX_HOME is replaced by the private home. Refused when the
  real home is itself under `codex-home/`. Fingerprint (program+args) is the same as notify-only.
- Open: AGENTS.md, prompts/, skills/, history.jsonl are not bridged (split from the real home); a token
  refresh that replaces auth.json by rename leaves the fresh token in `auth.json.unlinked-*` and relinks to
  the (possibly stale) real file [Unverified whether codex does that]; trust negative control (CX6) still open.
- New deps (already in Cargo.lock): sha2 0.10.9, toml 1.1.8, winapi-util 0.1.11 (Windows only).
