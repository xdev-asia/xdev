# UI end-to-end tests

Playwright specs that drive the real frontend in Chromium. The app runs against its in-memory mock
backend (no `__TAURI_INTERNALS__`), so no Rust build and no network beyond `localhost:1420` are needed.

## Run

```sh
corepack pnpm --filter desktop exec playwright install chromium   # once
corepack pnpm --filter desktop test:e2e
```

Playwright starts `vite` on port 1420 (or reuses one that is already running). It is not part of
`pnpm test`; vitest skips `e2e/**`.

Projects: `desktop` (1280x800, all specs except `narrow`) and `narrow` (360x740, `narrow.spec.ts` only).

## Covered

- `app.spec.ts`: demo workspace loads, first-launch wizard (`?welcome`), update banner (`?update=0.4.0`), crash dialog (`?crash`).
- `workspace.spec.ts`: command palette, create worktree dialog and its sources, terminal tab and new tab menu, open a file, sessions panel, automations page, docs Changes tab (seeded outside edit), agent kit Skills tab.
- `settings.spec.ts`: every settings section opens, settings search, SSH, command line, Advanced and Appearance pages.
- `paneChrome.spec.ts`: run timer on a busy agent tab, context and quota chips, chip switches in the terminal menu, sticky note (dot, send, library).
- `narrow.spec.ts`: no horizontal page scroll in the main layout and in settings at 360px, and the pane chips folding behind one button.

Every test also fails on an uncaught page error or a console error (see `fixtures.ts`). The wizard
is marked done through `localStorage` except in the `?welcome` test.
