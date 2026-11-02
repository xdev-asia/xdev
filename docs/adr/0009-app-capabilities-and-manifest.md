# 0009. App capabilities are declared in the manifest and checked by the app

Status: proposed. Code: `xdev-api` (host), `xdev-policy` (gate, audit).
Date: 2026-11-02

## Context

ADR 0001 says an app gets only the host functions its manifest grants, and
the person accepts them on install and on any update that adds one. ADR 0004
puts every risky step behind `xdev_policy::Gate::check` and `audit.jsonl`.
Apps and agents should share that one place of control, and the UI bridge
(ADR 0008), the WebAssembly host (ADR 0007) and the event bus (ADR 0011)
must all check the same list.

## Decision

- Every pack has `manifest.json` at its root:
  `id` (reverse-DNS, such as `asia.xdev.adr`), `name`, `version` (semver),
  `api` (range of `xdev:api`, such as `^1.2`), `publisher` (ed25519 key id,
  ADR 0010), `entry` (`plugin.wasm`, `ui/index.html`, both optional),
  `capabilities`, `activation` (events that load the app) and `contributes`
  (UI slots, and topics other apps may subscribe to). Unknown fields are an error, as in `Policy`.
- A capability is `<interface>:<verb>` with an optional scope:

  | Capability | Grants | Scope |
  |---|---|---|
  | `docs:read` | read docs in the vault | vault, or folder globs |
  | `docs:propose` | propose an edit; it lands in Changes for review | vault, or folder globs |
  | `search:query` | full-text and link queries | vault |
  | `storage` | key-value store private to the app | none |
  | `ai:invoke` | call a model; spends quota | provider |
  | `events:subscribe` | receive topics (ADR 0011) | topic patterns |
  | `events:publish` | send topics under `app.<id>.` | topic patterns |
  | `ui:slot` | add a view to a named shell slot | slot names |

  No capability gives raw SQL, file paths, sockets or commands. An app never
  writes a doc directly; it proposes, and a person approves.
- When the person is asked:
  - On install: the full list, each with its scope in plain words.
  - On update: only if a capability or scope is added. Until accepted, the
    old version keeps running.
  - At use: steps that ADR 0004 already gates (`ai:invoke`, and anything
    that touches the repo) pass `Gate::check` each time. `Ask` waits for a
    person; silence is never consent.
- Grants live in `<data_dir>/apps/<id>/grants.json`, owned by the person,
  like `policy.json`. An app cannot change it.
- Mapping to policy: the host asks the `Gate` with a new `Action` variant,
  `AppCall { app, capability, scope }`, for every call that touches the repo
  or spends quota, and for every grant and revoke. Calls inside a granted
  scope that only read (such as `docs:read`) are checked against
  `grants.json` without a `Gate` call.
- Every `Gate` decision is written through `Audited`, so app actions appear
  in `audit.jsonl` beside agent actions. If the record cannot be written,
  the call is denied.
- Revocation: the person can remove any capability, or turn the app off,
  in Settings. It takes effect on the next call; the call returns `denied`
  (ADR 0007). The app must handle `denied` without crashing.
- Third-party apps are installed turned off until the person turns them on.

## Consequences

- One capability list feeds three checks (bridge, host, bus); a mismatch
  is a bug in one place, not three designs.
- Writes always go through review, so an app cannot change a repo behind
  the person's back.
- Plain reads are not in the audit log; only gated calls, grants and
  revokes are.

## Open questions

- Whether grants should expire (for example, after a period unused).
- Whether `docs:read` needs scopes finer than folder globs, such as by tag.
- Whether plain reads should be counted per session in the audit log.
