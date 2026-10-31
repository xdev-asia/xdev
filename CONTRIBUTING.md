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
- UI colors, spacing and radii come from `packages/ui/tokens.json`. Do not hardcode them.
- Do not copy code from projects under AGPL or other incompatible licenses.
- Never commit secrets.

## Checks

```sh
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
corepack pnpm -r test
cargo test --workspace
```
