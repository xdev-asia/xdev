<img src="docs/brand/xdev-icon-512.png" alt="" width="96" align="right">

# xDev

[![CI](https://github.com/xdev-asia/xdev/actions/workflows/ci.yml/badge.svg)](https://github.com/xdev-asia/xdev/actions/workflows/ci.yml)

Local-first project knowledge for humans and AI agents.

Your Markdown files stay the source of truth. xDev indexes them, flags docs that went stale after code changed, exports agent context (AGENTS.md, CLAUDE.md, GEMINI.md, Cursor rules), and serves them over MCP.

> Status: early preview (0.1). Builds are unsigned; expect breaking changes.

## What works today

| Area | What |
|---|---|
| Docs | Open a folder of Markdown, edit with live preview, full-text search, wiki links and backlinks |
| History | Changes against git `HEAD`, review and commit from the app, per-file history |
| Stale docs | `xdev check` reports broken links and docs that went stale or were never verified |
| Agent context | `xdev export` writes AGENTS.md, CLAUDE.md, GEMINI.md and a Cursor rule; `xdev mcp` serves the docs over MCP stdio |
| Tasks | A coding agent works in its own git worktree; you review the evidence and diff, then approve or discard |
| Accounts | Claude Code accounts and quota on this machine; API keys in the OS keychain; local Ollama models (CLI only: `xdev ai models`) |

Guides: [status and notifications](docs/guide/status-and-notifications.md). All guides: [docs/guide](docs/guide/README.md).

## Install

Download from [Releases](https://github.com/xdev-asia/xdev/releases) or [xdev.asia](https://xdev.asia):

| OS | Builds |
|---|---|
| Windows | x64 (`.exe`, `.msi`), ARM64 (`.exe`) |
| macOS | Apple silicon, Intel (`.dmg`) |
| Linux | x64, ARM64 (`.AppImage`, `.deb`) |

The `xdev` CLI ships as a separate archive per target on the same page. Installers are not code-signed yet, so Windows SmartScreen and macOS Gatekeeper will warn. Updates are signed: the app downloads them in the background and installs on the next start.

## Layout

| Path | What |
|---|---|
| `crates/` | Rust core: `xdev-core`, `xdev-vault`, `xdev-store`, `xdev-git`, `xdev-export`, `xdev-mcp`, `xdev-ai`, `xdev-agent`, `xdev-policy`, `xdev-api`, `xdev-cli` |
| `apps/desktop` | Tauri 2 + React desktop app |
| `app-packs/` | Apps that install into the shell (`docs`, `adr`). Deferred: placeholder manifests, no plugin host (ADR 0001) |
| `packages/ui` | Design tokens and shared components |
| `packages/bindings` | TypeScript types generated from Rust (`cargo test -p xdev-desktop export_bindings`) |
| `docs/adr/` | Architecture decisions |
| `docs/guide/` | User guides |

## Develop

Requirements: Rust (see `rust-toolchain.toml`), Node 24, pnpm via corepack. On Windows you also need the MSVC C++ build tools.

```sh
corepack pnpm install
corepack pnpm -r test
cargo test                                  # crates only
corepack pnpm --filter desktop build        # frontend, needed before the next line
cargo test --workspace                      # crates + desktop
corepack pnpm --filter desktop tauri dev    # run the app
cargo run -p xdev-cli -- --help
```

## Related repos

| Repo | What |
|---|---|
| [xdev-asia/registry](https://github.com/xdev-asia/registry) | Signed index of installable app packs. Deferred with app packs (ADR 0010) |
| [xdev-asia/site](https://github.com/xdev-asia/site) | Website and user docs |

## License

Apache-2.0. See `LICENSE` and `CONTRIBUTING.md`.
