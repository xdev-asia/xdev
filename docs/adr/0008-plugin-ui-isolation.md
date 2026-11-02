# 0008. Plugin UI in an opaque-origin iframe, talking only by `postMessage`

Status: proposed.
Date: 2026-11-02

## Context

ADR 0001 runs an app's UI as HTML/JS in a sandboxed iframe with no Tauri IPC.
Tauri capabilities are not enough on their own: the Tauri docs state that
Tauri "is unable to distinguish between requests from an embedded `<iframe>`
and the window itself" on Linux and Android. So the boundary must be the
browser's origin rules, not Tauri's allowlist.

## Decision

- Assets: each app's `ui/` is served by a custom protocol registered by the
  shell, `xdev-app://<app-id>/`. It serves files only from that app's
  verified pack (ADR 0010), read-only. No path outside `ui/` resolves.
- Frame: `<iframe sandbox="allow-scripts">` with no `allow-same-origin`,
  `allow-top-navigation`, `allow-popups` or `allow-forms`. The frame gets an
  opaque origin: no cookies, no `localStorage` shared with the shell, no
  access to `window.parent`'s DOM.
- CSP sent with every app asset:
  `default-src xdev-app://<app-id>; script-src xdev-app://<app-id>;
  connect-src 'none'; frame-src 'none'`. It never lists `ipc:` or
  `http://ipc.localhost`. Network for an app goes through a granted
  `xdev:api` interface, not `fetch`.
- Bridge: the shell keeps a map from each iframe's `contentWindow` to its
  app id. A message is handled only if `event.source` is in that map; the
  claimed origin is ignored, since it is `null` for every app.
- Messages are JSON: `{ id, method, params }` in, `{ id, result }` or
  `{ id, error: { code } }` out. `method` names are `xdev:api` functions
  (ADR 0007), such as `docs.read`. Events from ADR 0011 come down as
  `{ topic, payload }`.
- The shell checks each call against the app's granted capabilities
  (ADR 0009) before it forwards it to the host. Calls that touch the repo or
  spend quota then pass `xdev_policy::Gate` like any other action.
- The bridge is a small JS library shipped in the SDK. Apps may use it or
  speak the message format directly; the shell trusts neither.
- A test runs on Windows, macOS and Linux: inside an app frame,
  `window.__TAURI_INTERNALS__` is undefined and every attempt to reach IPC
  fails. The test gates releases.

## Consequences

- An app's UI cannot call Tauri commands, read the shell's DOM or reach
  another app's frame, even on Linux.
- Apps cannot use `fetch`, cookies or `localStorage`; persistent state goes
  through `storage`. Some web libraries will need adapting.
- Every UI call costs a message round trip. This is acceptable for UI work;
  heavy work belongs in the app's WebAssembly component.
- One capability check in the shell, then the same `Gate` as agents: one
  place to audit.

## Open questions

- Tauri multiwebview (one webview per app) would add a process boundary.
  It is behind an `unstable` flag today; revisit when it is stable.
- Whether custom-protocol iframes behave the same on all three webviews
  (WebView2, WKWebView, WebKitGTK) is to be confirmed by the test above
  before this ADR is accepted.
