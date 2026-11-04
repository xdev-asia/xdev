# Contributing

Thanks for helping.

## Sign-off (DCO)

Every commit needs a `Signed-off-by` line, which certifies the [Developer Certificate of Origin](https://developercertificate.org/):

```sh
git commit -s -m "fix: describe the change"
```

## Rules

- Keep commits small. Write messages in English.
- When you add a third-party library, say why in the commit message.
- Code comments explain why, not what.
- UI colors, spacing and radii come from `packages/xdev-ui/tokens/tokens.json`. Do not hardcode them.
- Do not copy code from projects under AGPL or other incompatible licenses.
- Never commit secrets.
- Do not name other products in code, UI strings or docs.

## Checks

```sh
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
corepack pnpm -r test
cargo test --workspace
```

## Releases

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
(`feat:`, `fix:`, `chore:` …). release-please reads them to keep a release PR
open on GitHub; merging that PR publishes the next version (ADR 0005).

## Building installers

`tauri build` also writes signed update bundles, so it needs the updater key
(ADR 0005). Without it, build the app alone:

```sh
cd apps/desktop
corepack pnpm tauri build --no-bundle
```

The terminal service `xdev-ptyd` is built by the before-build command and
lands next to the app. Installers ship it as a sidecar only with its config:

```sh
corepack pnpm tauri build --config src-tauri/tauri.ptyd.conf.json
```
