# 0005. Updates are signed with a key the owner holds; OS code signing comes later

Status: accepted. Code: `apps/desktop/src-tauri/src/updater.rs`,
`tauri.conf.json` (`plugins.updater`), `.github/workflows/release.yml`,
`release-please-config.json`.
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
  and a status-bar button that quits through the quit guard with a restart
  (`shell_quit("restart")`), and an update not installed by then installs when
  the app quits, so running agents are never
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
- Releases are cut by release-please from Conventional Commits on main. It
  keeps a release PR open; merging it bumps the version, tags it and opens a
  draft release. The build then signs installers for Windows (x64, ARM64),
  macOS (Apple silicon only; Intel dropped 2026-11-04) and Linux (x64, ARM64), uploads them with a
  `latest.json` that lists all six, and publishes the release. Merging the PR
  and approving the `release` environment are the two human steps; an
  install sees an update only after the release is published.
- Installers are not code-signed by Apple or Microsoft yet. Windows shows
  SmartScreen and macOS needs right-click, Open. Who signs is decided when
  there is a legal entity; it does not change the updater key.

## Consequences

- Losing the private key means every install must be reinstalled by hand to
  get updates again. Leaking it lets anyone sign a fake update. Rotation
  needs an update signed with the old key that ships the new public key.
- Two channels, stable and release candidate (below). Staged rollout needs an
  endpoint xDev controls; moving the endpoint also needs an update signed with
  the current key.
- [Inference] On macOS, ad-hoc signed builds change identity on each update,
  so Keychain may ask again for access to stored API keys until the app is
  signed with a Developer ID.

- A manual "Check for updates" (Settings, General, and the tray and macOS menu) runs the same signed check as the background one; it adds no new trust path and no new key.
- Release builds ship with the Tauri `devtools` feature on, so Help, Toggle developer tools opens the web inspector in an installed app. It runs only on the person's own machine and adds no network surface or capability.

## Amendment 2026-11-04: release candidate channel

- The setting `updateChannel` is `stable` (default) or `rc`. Stable keeps
  reading `releases/latest/download/latest.json`. An install on `rc` reads
  `releases/download/rc-latest/latest.json` instead. A missing file (404) reads
  as "up to date", not as an error, so the channel works before the first
  candidate exists.
- The same updater key signs candidates, and the app has the same public key
  for both channels: there is no second trust path and no second key.
- Candidates are built only by a manual run of `release.yml` (`workflow_dispatch`
  with `rc_version`, such as `0.6.0-rc.1`; no push or schedule starts one). The
  `build` job then runs in the `release` environment and a reviewer must
  approve it, as for a stable release. The build sets the app version to
  `rc_version`, so an installed candidate does not offer itself again.
- The `rc-latest` job also runs in `release` (a second approval) and writes
  `latest.json` for the same five bundles. With `rc_publish` off it is a dry
  run: `latest.json` is attached to the run and nothing is uploaded. With it
  on, the job replaces the assets of a prerelease named `rc-latest`, created
  with `--latest=false` so `releases/latest` (stable) does not move.
- Consequence: an install moves from `rc` back to stable only when a stable
  version is higher than its candidate (semver: `0.6.0` is higher than
  `0.6.0-rc.1`). Losing or leaking the key has the same effect on both
  channels.
