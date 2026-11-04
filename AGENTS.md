# AGENTS.md

Instructions for coding agents in this repo. Human rules (sign-off, commits, licenses) are in [CONTRIBUTING.md](CONTRIBUTING.md) and apply to agents too.

## UI

Components, styles, tokens, icons and brand come from [`@xdev-asia/ui`](https://github.com/xdev-asia/xdev-ui), a git submodule at `packages/xdev-ui` (`workspace:*` in `apps/desktop`). The app imports `@xdev-asia/ui` and `@xdev-asia/ui/styles.css`; the `xdev-source` export condition resolves them to `packages/xdev-ui/src`, so no library build is needed to run, type-check or test the app.

After a fresh clone: `git submodule update --init --recursive`, then `corepack pnpm install`.

Change shared UI in `packages/xdev-ui`, not in the app:

1. Commit in `packages/xdev-ui` (its own tests: `corepack pnpm --filter @xdev-asia/ui test`).
2. Bump the pin in the same commit as the app change: `git -C packages/xdev-ui checkout <sha> && git add packages/xdev-ui`. Pin a commit SHA, never a branch.
3. If the library's `package.json` dependencies changed, run `corepack pnpm install` and commit `pnpm-lock.yaml`.

Before writing or changing UI, ask the `xdev-ui` MCP server (`.mcp.json`). It runs from the built library, so build it once (and again after the pin moves):

```sh
corepack pnpm --filter @xdev-asia/ui build
```

| need | tool |
|---|---|
| which component or pattern fits | `xdevui_list_components`, `xdevui_search_docs` |
| props, rules, CSS classes of one part | `xdevui_get_component` |
| colour, space, radius, type size | `xdevui_search_tokens` |
| icon name | `xdevui_list_icons` |
| voice, layout, brand | `xdevui_get_guidelines` |

No MCP client: read `packages/xdev-ui/dist/llms-full.txt` (after the build), or `packages/xdev-ui/docs` and `packages/xdev-ui/src`.

Rules:

- Do not invent props, classes or tokens. Use what the MCP server returns, or what already exists in `packages/xdev-ui` and `apps/desktop/src/styles`.
- No colour literals in the app (`apps/desktop/src/styles/no-hardcoded-colors.test.ts` fails the build). Raw colours live only in `packages/xdev-ui/tokens/tokens.json`.
- State is a tint, a 1px border or a status dot. Never a coloured left stripe on a rounded card or row.
- One primary button per surface. A `<Button>` inside a `<form>` states `type="submit"` or `type="button"`; the default is `button`.
- Labels: sentence case verbs, no emoji, no exclamation marks. Every string goes through i18n (`en` and `vi`).
- A part the design system lacks belongs in `packages/xdev-ui` first, not as a one-off here.

## Checks

```sh
git submodule update --init --recursive
corepack pnpm install --frozen-lockfile
corepack pnpm -r typecheck
corepack pnpm -r test
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```
