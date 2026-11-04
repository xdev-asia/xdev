# AGENTS.md

Instructions for coding agents in this repo. Human rules (sign-off, commits, licenses) are in [CONTRIBUTING.md](CONTRIBUTING.md) and apply to agents too.

## UI

The design system is [`@xdev-asia/ui`](https://github.com/xdev-asia/xdev-ui) (source: `xdev-asia/xdev-ui`). Its classes (`.ws-tab`, `.x-menu`, `.dialog`, `.segmented` …) and tokens (`--accent`, `--line`, `--x-space-*` …) share names with `apps/desktop/src/styles/*.css`, which they were extracted from.

Before writing or changing UI, ask the `xdev-ui` MCP server (`.mcp.json`, starts after `corepack pnpm install`):

| need | tool |
|---|---|
| which component or pattern fits | `xdevui_list_components`, `xdevui_search_docs` |
| props, rules, CSS classes of one part | `xdevui_get_component` |
| colour, space, radius, type size | `xdevui_search_tokens` |
| icon name | `xdevui_list_icons` |
| voice, layout, brand | `xdevui_get_guidelines` |

No MCP client: read `apps/desktop/node_modules/@xdev-asia/ui/dist/llms-full.txt`.

Rules:

- Do not invent props, classes or tokens. Use what the MCP server returns, or what already exists in `apps/desktop/src/styles`.
- No colour literals outside `apps/desktop/src/styles/base.css` (`packages/ui/src/no-hardcoded-colors.test.ts` fails the build).
- State is a tint, a 1px border or a status dot. Never a coloured left stripe on a rounded card or row.
- One primary button per surface. Keep the `:focus-visible` ring from `base.css`.
- Labels: sentence case verbs, no emoji, no exclamation marks. Every string goes through i18n (`en` and `vi`).
- A part the design system lacks belongs in `xdev-asia/xdev-ui` first, not as a one-off here.

## Checks

```sh
corepack pnpm -r typecheck
corepack pnpm -r test
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```
