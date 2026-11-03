# 0007. One versioned WIT world, `xdev:api@1`, that only grows

Status: Deferred (2026-11-02): not implemented; product focus moved to
workspace agents (see 0013). Code: `xdev-api` (placeholder today).
Date: 2026-11-02
Note: no WIT package is published and no WebAssembly host exists.

## Context

ADR 0001 puts app logic in a WebAssembly component and says `xdev-api` is
versioned and changes by adding. Once third parties build against it, the
world cannot change shape. We need to fix now: which WASI the world sits on,
whether calls are sync or async, how long old versions keep working, and how
a breaking change ships.

## Decision

- One WIT package, `xdev:api`, with one world, `app`. Its interfaces: `docs`,
  `search`, `storage`, `ai`, `events` (ADR 0011), `ui-slot` and
  `permissions` (ADR 0009). An app imports only what it uses.
- WASI baseline: WASI 0.2 (`wasm32-wasip2`). The world does not import
  `wasi:filesystem` or `wasi:sockets`. Files, network and data reach an app
  only through `xdev:api` interfaces the manifest grants. Clocks and random
  are allowed.
- Calls are sync from the app's side. Work that takes long (an AI call, a
  search over a large vault) returns a handle at once; progress and the
  result arrive as events. The host runs each app on its own task with
  Wasmtime fuel or epoch limits, so a slow app cannot block the shell.
- Versioning is semver on the package: `xdev:api@1.x.y`.
  - A minor version only adds: new functions, new interfaces, new optional
    record fields behind new functions. Each item carries `@since(version)`.
  - The host keeps bindings for every `1.x` it has shipped. An app built for
    `1.2` runs on any host with `1.2` or later.
  - The manifest states the range it needs (`"api": "^1.2"`). A host older
    than that refuses to load the app and says why.
- A breaking change ships as a new major, `xdev:api@2`, next to `@1`. The
  host runs both. `@1` stays supported for at least 12 months after `@2`
  ships; the app shows which installed apps still use `@1`.
- Errors are a WIT `variant` per interface with a stable code, the same style
  as `PolicyError::code`. `denied` is one of them in every interface.
- Wasmtime is pinned in `Cargo.lock` and updated on purpose, not on every
  release. Each update must pass an `xdev-api` conformance suite: a set of
  test components, one per published minor version.

## Consequences

- Apps cannot open files or sockets on their own; everything goes through a
  checked interface. Some apps will need features we have not added yet.
- Sync calls are easier to write against and to bind from Rust, JS and other
  guest languages. Long work needs the handle-plus-event pattern.
- Keeping every `1.x` binding costs host code; the conformance suite is what
  keeps that cost honest.
- The UI side (ADR 0008) speaks the same interfaces as JSON over
  `postMessage`, so one capability check covers both.

## Open questions

- WASI 0.3 adds native async (`stream`, `future`). Whether `xdev:api@2`
  should move to it, or a `1.x` minor can add async variants beside the
  sync ones, is not decided. Wasmtime's current defaults should be checked
  before we pin.
- Whether an app may import `wasi:http`, or only a narrower `xdev:api`
  `http` interface limited to hosts named in the manifest.
