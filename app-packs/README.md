# App packs

Apps that install into the xDev shell. Each folder has an `xdev-app.toml` manifest:

| Field | Meaning |
|---|---|
| `id` | Unique app id |
| `version` | App version (semver) |
| `engines.xdev-api` | Range of `xdev-api` versions the app works with |
| `requires` | Other apps that must be installed first |
| `permissions` | Host capabilities the app asks for; the host checks them on every call |
| `[[nav]]` | Entries the app adds to the shell navigation |

`docs` is the core app. `adr` is the first app built only on the public `xdev-api`, to prove that third parties can do the same.

The manifests are placeholders until the plugin host exists.

> Deferred (2026-11-02): the plugin host and app packs are not being built; product focus moved to workspace agents. See `docs/adr/0001-app-runtime.md` and `docs/adr/0013-agents-in-pty-terminals.md`.
