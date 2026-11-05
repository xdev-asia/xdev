<img src="docs/brand/xdev-icon-512.png" alt="" width="96" align="right">

# xDev

[![CI](https://github.com/xdev-asia/xdev-ide/actions/workflows/ci.yml/badge.svg)](https://github.com/xdev-asia/xdev-ide/actions/workflows/ci.yml)

Local-first agentic IDE. Run Claude Code, Codex and other coding agents side by side, each in its own git worktree, with the editor, git review and project context in one window.

Your code, Markdown docs and git stay the source of truth. xDev keeps nothing in the cloud: agents run in local terminals with your own accounts.

> Status: early preview (0.5). Builds are unsigned; expect breaking changes.

## What works today

| Area | What |
|---|---|
| Worktrees | One worktree per task, created in the background from a branch or a GitHub issue (`#N`); branch prefixes, setup and archive scripts (`xdev.toml`), shared paths, archive and restore |
| Agents and terminals | Agent and shell tabs in split panes; Claude Code and Codex status (working, needs you, done) through hooks; notifications, sound and taskbar badge; session history and resume; layouts come back after restart |
| Editor | File tabs with a CodeMirror editor, file explorer, quick open (`Mod+P`), search in files, jump palette (`Ctrl+J`) |
| Review and git | Diff against a chosen base, stage and unstage, line and range notes sent to an agent tab, commit, pull request defaults; AI recipes for commit, PR and branch text |
| Docs and context | Markdown with live preview, wiki links and backlinks; `xdev check` flags stale docs; `xdev export` writes AGENTS.md, CLAUDE.md, GEMINI.md and a Cursor rule; `xdev mcp` serves docs and context packs over MCP |
| Accounts and usage | Claude Code accounts and quota on this machine, token usage per session, API keys in the OS keychain, local Ollama models for embeddings |
| Settings | General, agents, terminal, git, notifications, shortcuts (`keybindings.json`), Open In apps, quick commands; settings search, close to tray |

Guides: [status and notifications](docs/guide/status-and-notifications.md). All guides: [docs/guide](docs/guide/README.md).

## Install

Download from [Releases](https://github.com/xdev-asia/xdev-ide/releases) or [xdev.asia](https://xdev.asia):

| OS | Builds |
|---|---|
| Windows | x64 (`.exe`, `.msi`), ARM64 (`.exe`) |
| macOS | Apple silicon (`.dmg`); Intel Macs are not built |
| Linux | x64, ARM64 (`.AppImage`, `.deb`) |

The `xdev` CLI ships as a separate archive per target on the same page. Installers are not code-signed yet, so Windows SmartScreen and macOS Gatekeeper will warn. Updates are signed: the app downloads them in the background and installs on the next start; Settings, General can also check on demand.

## Architecture

The desktop app (Tauri host plus React UI) talks to a separate per-user terminal service, `xdev-ptyd`, over a local socket or named pipe (`xdev-ipc`, token auth). Terminals and agents run inside the service, so sessions survive an app restart or reload and the UI re-attaches. Each agent provider has one active account; new agent tabs launch with its config dir. Details: [docs/architecture.md](docs/architecture.md).

## Layout

| Path | What |
|---|---|
| `crates/` | Rust core: `xdev-core`, `xdev-workspace`, `xdev-pty`, `xdev-ipc`, `xdev-agent`, `xdev-kit`, `xdev-git`, `xdev-vault`, `xdev-store`, `xdev-export`, `xdev-mcp`, `xdev-ai`, `xdev-policy`, `xdev-api`, `xdev-cli`. Map: [docs/architecture.md](docs/architecture.md) |
| `apps/desktop` | Tauri 2 + React desktop app |
| `app-packs/` | Apps that install into the shell (`docs`, `adr`). Deferred: placeholder manifests, no plugin host (ADR 0001) |
| `packages/xdev-ui` | Design tokens and shared components (git submodule, `@xdev-asia/ui`) |
| `packages/bindings` | TypeScript types generated from Rust (`cargo test -p xdev-desktop export_bindings`) |
| `docs/architecture.md` | How the pieces fit: crates, terminal service, accounts, where data lives |
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
