# 0005. Updates are signed with a key the owner holds; OS code signing comes later

Status: accepted. Code: `apps/desktop/src-tauri/src/updater.rs`,
`tauri.conf.json` (`plugins.updater`), `.github/workflows/release.yml`.
Date: 2026-11-02

## Context

Without an updater, every fix needs each person to download a new installer.
The Tauri updater checks a signature on every update and the check cannot be
turned off, so whoever holds the signing key can ship code to every install.
That key is separate from Apple and Microsoft code-signing certificates.

## Decision

- Updates use `tauri-plugin-updater`, driven from Rust: it checks at start
  and every 6 hours, downloads a new release in the background and emits
  `update-ready`; the UI shows one OS notification (`tauri-plugin-notification`)
  and a status-bar button that calls `update_restart`, and an update not
  installed by then installs when the app quits, so running agents are never
  cut off. The webview gets no updater or notification permission and no extra
  JS package. Bundles are built with `createUpdaterArtifacts`, so each
  installer gets a `.sig`.
- The updater keypair is generated on the owner's machine
  (`tauri signer generate`). On 2026-11-02 a coding agent ran that step at
  the owner's request, wrote the key and password to the owner's
  `~/.tauri/`, and set them as secrets without printing, logging or
  committing them. The public key goes in `tauri.conf.json`. The private
  key and its password are kept in the owner's password manager, in one
  offline copy, and as secrets of a GitHub Environment `release` that needs
  a reviewer. xDev itself never sees the private key.
- The release workflow signs in that environment and uploads `latest.json`
  next to the installers on GitHub Releases. The app reads
  `releases/latest/download/latest.json`.
- Releases stay drafts until the owner publishes them; an install sees an
  update only after that.
- Installers are not code-signed by Apple or Microsoft yet. Windows shows
  SmartScreen and macOS needs right-click, Open. Who signs is decided when
  there is a legal entity; it does not change the updater key.

## Consequences

- Losing the private key means every install must be reinstalled by hand to
  get updates again. Leaking it lets anyone sign a fake update. Rotation
  needs an update signed with the old key that ships the new public key.
- One channel only. A beta channel or staged rollout needs an endpoint xDev
  controls; moving the endpoint also needs an update signed with the current
  key.
- [Inference] On macOS, ad-hoc signed builds change identity on each update,
  so Keychain may ask again for access to stored API keys until the app is
  signed with a Developer ID.
