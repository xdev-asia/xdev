# Tray, menu, help and updates

## Window and tray

Settings, General, Window:

- **Minimize to tray on close**: closing the window hides it and xDev keeps running. A notice says so the first time.
- **Show menu bar icon**: on macOS, keeps the tray icon in the menu bar.

The tray exists on Windows and macOS. Its menu: Open xDev, Settings, Check for updates, Quit xDev. On Windows a left click shows the window.

The icon gets a dot when an agent needs you (the same events as the OS notification) while the window is hidden or minimized. Focusing the window clears it.

## Quit

Every quit asks the shell first, so the tray, the menu and the window close button agree. Quit keeps terminals running when "On quit" is set to keep them. **Quit and end terminals** (macOS app menu, with a confirmation) ends every terminal first.

## Menu and help

macOS has a native menu: xDev, Edit, View, Window, Help. Windows and Linux use the Help button in the header, left of the gear:

| Item | Does |
|---|---|
| Keyboard shortcuts | Opens Settings, Keyboard shortcuts |
| Documentation, Getting started, Changelog, Report an issue, Source on GitHub | Opens the page in the browser |
| About xDev | Shows the version |
| Restart xDev | Restarts the app, installing a downloaded update first |

Native menu accelerators are bound only for keys the app's own keymap does not own, so your rebinds are not swallowed.

## Updates

Settings, General, Updates shows the version and a **Check for updates** button. xDev also checks on launch and every 6 hours, downloads in the background, and installs on the next start or on **Restart to update**.

Release channel: Stable, or Release candidate. Shift-click on the button checks the release candidate feed and keeps following it. No release candidate published is shown as up to date.
