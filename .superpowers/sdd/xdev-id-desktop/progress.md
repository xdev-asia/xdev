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
