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
