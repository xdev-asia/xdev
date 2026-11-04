# Ledger: xdev-id-desktop

Plan: ~/xdev-lanes/plans/2026-11-04-xdev-id-desktop.md

Task 1: complete
Task 2: complete
Task 3: complete
Task 4: complete
Task 5: complete
Task 6: complete
- Decision: a stored token without a stored profile is held in memory and shows SignedOut until the first /me fills the profile (refreshed).
- Decision: begin() while signed in is allowed; cancel/expire fall back to SignedIn. A refresh never hides a running attempt.
Task 7: complete
- Deviation: agent_config takes the request URL (not base + timeout) so /signout picks its 5 s timeout; returns a TransportConfig.
Task 8: complete (5ab19b0)
- Plugins resolved at 2.6.3 / 2.5.5 / 2.7.2 (no fallback needed). move_indexes moved into setup: no .manage(...) constructor reads the index folders.
- Deviation: xdev-id gets a `random_pair()` helper (verifier + state bytes) and a `test-util` feature exporting FakeTransport; desktop dev-deps enable it.
- Commands: xdev_id_state, xdev_id_sign_in, xdev_id_paste, xdev_id_cancel, xdev_id_sign_out, xdev_id_refresh, xdev_id_manage. Event: xdev-id://changed.
- Generated: packages/bindings/src/XdevIdState.ts, XdevIdUser.ts, index.ts export.
- CSP: default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ipc: http://ipc.localhost
Task 9: complete (ffbfd3e)
- Unit test only; deb not built (the Exec=/MimeType= lines of an extracted deb are unchecked: review item, hive-hub build not run).
Task 10: complete (a58b095)
Task 11: complete (xdev-ui 830aad3, branch feat/xdev-id-desktop, Avatar; not pushed)
Task 12: complete (90853f1)
- Deviation: xdev-ui Button has only primary|secondary, so Cancel is secondary (no ghost). Banner has no tone prop; the notice is its title.
- SettingsView.test.tsx indexes and counts shifted by one for the new Account section after General.
Task 13: Windows gate passed (see report). macOS (srv86) and Linux (hive-hub) gates not run from this Windows session.

Review round 1: complete (fix round, on-prem server, merge main)
- Minor 1: AccountPage applies the refresh answer. Minor 2: load returns early while an attempt or a token exists. Minor 4: begin is refused with account_state while a token is held (replaces the Task 6 decision "begin() while signed in is allowed"). Minor 5: unknown callback parameters are rejected. Minor 6: xdev_id_reopen opens the running link. Minor 7: mock checks the link shape first. Minor 8: copied resets in apply and run. Section label is "xDev ID" (en, vi).
- Minor 3 (a 401 during an attempt loses its notice): not reachable after Minor 2 and 4, since no token can exist during an attempt. No code added.
- Server setting xdevId.server: env XDEV_ID_URL > setting > https://id.xdev.asia. The keychain entry stores the origin with the token; a token for another origin is dropped without a request. A server change cancels the attempt, revokes at the old server, clears the keychain, then switches. Edits to settings.json apply at the next start.
- Deviation: Save in the Server row is secondary, so the page keeps one primary button (Sign in).
- Generated: XdevIdServer.ts, ServerSource.ts, XdevIdSettings.ts.
