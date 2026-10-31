# xDev

Local-first project knowledge for humans and AI agents.

Your Markdown files stay the source of truth. xDev indexes them, flags docs that went stale after code changed, exports agent context (AGENTS.md, CLAUDE.md, GEMINI.md, Cursor rules), and serves them over MCP.

> Status: skeleton. Nothing useful runs yet. See `docs/superpowers/specs/` for the design.

## Layout

| Path | What |
|---|---|
| `crates/` | Rust core: `xdev-core`, `xdev-vault`, `xdev-store`, `xdev-git`, `xdev-export`, `xdev-mcp`, `xdev-ai`, `xdev-api`, `xdev-cli` |
| `apps/desktop` | Tauri 2 + React desktop app |
| `app-packs/` | Apps that install into the shell (`docs`, `adr`) |
| `packages/ui` | Design tokens and shared components |
| `packages/bindings` | TypeScript types generated from Rust (later) |

## Develop

Requirements: Rust (see `rust-toolchain.toml`), Node 24, pnpm via corepack. On Windows you also need the MSVC C++ build tools.

```sh
corepack pnpm install
corepack pnpm -r test
cargo test                                  # crates only
corepack pnpm --filter desktop build        # frontend, needed before the next line
cargo test --workspace                      # crates + desktop
corepack pnpm --filter desktop tauri dev    # run the app
cargo run -p xdev-cli -- --version
```

## License

Apache-2.0. See `LICENSE` and `CONTRIBUTING.md`.
