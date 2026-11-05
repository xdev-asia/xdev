# Ports

The Ports tab in the right panel lists the TCP ports that are listening on this computer and ties each one to a workspace.

## Reading the list

- **This workspace** holds ports whose process runs inside the worktree in front. This section is open.
- **Other workspaces** holds ports that belong to another worktree. It starts closed.
- **Outside workspaces** holds containers and processes that no worktree owns. It starts closed.

Each row shows the port, the process name (or its pid), the address and the owner. The owner line also says how xDev linked the port to the worktree: from a terminal, from the process directory, or from a URL the terminal printed.

## Actions

- **Open** opens the port in the default browser. A printed URL opens as printed; otherwise xDev uses `http://localhost:<port>`.
- **Copy address** copies the address. **Copy details** (context menu, right-click the address line) copies the port as JSON.
- **Stop** ends the process. It is offered only for a port in a workspace that has a known pid.

## When it scans

The tab scans when it comes to the front, every 30 seconds while it stays in front, and when a terminal prints a URL. It does not scan while hidden. A scan that takes more than 4 seconds is dropped and the tab pauses (first 60 seconds, then up to 5 minutes) before it tries again.

The status bar shows the number of ports of the workspace in front. Turn it off in Settings, Appearance, Status bar.

## Per system

| System | How ports are read |
|---|---|
| Windows | `netstat` for the listeners, `taskkill` to stop a process |
| macOS | `lsof`, with `netstat` as a fallback |
| Linux | `/proc/net/tcp` and `/proc/net/tcp6`, matched to processes through `/proc` |

On macOS the shortcut Cmd+Shift+I opens the tab. Windows and Linux have no default key; assign one under Settings, Keyboard.

## Limits

- Only listening TCP ports are shown. UDP is not.
