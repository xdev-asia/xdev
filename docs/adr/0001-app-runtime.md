# 0001. App runtime: three trust tiers

Status: accepted (direction).
Date: 2026-11-02

## Context

xDev opens to third-party apps (level 3). An app from a stranger must not be
able to read the person's files, keys or other apps' data. The team's own apps
(Docs, ADR) should use the same path, so the API is exercised before anyone
else depends on it.

## Decision

Three tiers, each with its own boundary:

| Tier | Runs as | Boundary | Who may ship it |
|---|---|---|---|
| UI | HTML/JS in a sandboxed iframe in the shell | No Tauri IPC; talks to the host by `postMessage` through `xdev-api` | Anyone, signed |
| Logic | WebAssembly component in wasmtime, interface in WIT (`xdev-api`) | Memory and time limits; only host functions the manifest's permissions grant | Anyone, signed |
| Native | Sidecar process or agent tool | OS process; runs only through `xdev-policy` | xDev team only, until an OS sandbox exists |

- A pack (`.xpkg`) is a zip of manifest, `plugin.wasm` and `ui/`, signed with
  ed25519. Wrong signature or hash: the pack is not loaded.
- The person sees and accepts the manifest's permissions on install and on
  every update that adds one.
- Apps get storage through `xdev-api`, never raw SQL or file paths.
- The registry is a signed static `index.json` with a block list; the app
  turns off a blocked pack.

## Consequences

- `xdev-api` is the longest-lived interface; it is versioned (`^1.0`) and
  changes by adding, not by breaking.
- Native apps from third parties wait for an OS-level sandbox.
- [Unverified] Sigstore/SLSA provenance can be added on top of ed25519
  signing later; not evaluated yet.
