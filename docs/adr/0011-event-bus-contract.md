# 0011. Events are notifications: named topics, at-most-once, bounded queues

Status: proposed. Code: `events` interface in `xdev-api`.
Date: 2026-11-02

## Context

`events` is part of the `xdev:api` world (ADR 0007), so topic names, payload
shapes and ordering become ABI the day a third-party app subscribes. Apps
also use events to get results of long calls and to be loaded only when
needed. The files the person owns are the source of truth; events only say
that something changed.

## Decision

- Topic names: lowercase, dot-separated, `<owner>.<object>.<event>`, with
  the event in past tense or as a state.
  - Core topics start with `xdev.`: `xdev.doc.changed`, `xdev.doc.deleted`,
    `xdev.vault.synced`, `xdev.task.state_changed`, `xdev.call.completed`.
  - App topics start with `app.<app-id>.`, such as
    `app.asia.xdev.adr.decision.created`.
  - Subscriptions may end in `.*` (one level) or `.**` (any depth).
- Payloads are a WIT record per topic, sent as JSON to the UI bridge
  (ADR 0008). They carry ids, paths and states, not document contents or
  secrets; an app reads contents through `docs` if it has `docs:read`.
  Payload size is capped at 64 KiB.
- A topic's payload is versioned with `xdev:api`: a minor version may add
  optional fields; removing or renaming one is a major change.
- Delivery is at-most-once and in-process. Events are not stored or
  replayed. An app that needs the current state reads it through the API.
- Ordering: events from one publisher on one topic arrive in the order sent.
  There is no order across topics or across publishers.
- Backpressure: each subscriber has a bounded queue (256 events). When it
  is full, the oldest events are dropped and the next delivery is
  `xdev.bus.lagged` with the number dropped, so the app knows to re-read.
  A publisher is never blocked by a slow subscriber.
- What an app may do, checked against its grants (ADR 0009):
  - Publish only under its own `app.<id>.` prefix, and only topics listed
    under `events:publish`.
  - Subscribe only to patterns listed under `events:subscribe`. A core
    topic also needs the capability for its object: `xdev.doc.*` needs
    `docs:read` with a scope that covers the doc's path; events outside the
    scope are not delivered.
  - Subscribe to another app's topics only if that app lists them under
    `contributes` in its manifest.
- `activation` in the manifest may name topics; the host loads the app on
  the first matching event instead of at startup.
- The bus itself makes no `Gate` calls; acting on an event goes through the
  normal checked API.

## Consequences

- No event store and no delivery acknowledgements to build or migrate.
- Apps must treat events as hints and be able to re-read state; a missed
  event is never data loss.
- A noisy app slows only itself.
- Core topic names are a public contract and need the same care as WIT
  functions.

## Open questions

- Whether some workflows need at-least-once delivery (for example, an app
  that mirrors task states elsewhere), and if so, whether that belongs in
  the bus or in a separate, stored outbox.
- Whether the queue size should be set per app in the manifest.
