# Agent hooks CLI

The `xdev` command line has two sets of commands for the status hooks described in [Status and notifications](status-and-notifications.md): one to turn the hooks on or off, and one for an agent or script to ask for you.

## `xdev agent hooks`

```
xdev agent hooks status [--json]
xdev agent hooks on     [--json]
xdev agent hooks off    [--json]
```

The commands read and write two things:

- **The setting**: `status.hooks` in the desktop's `settings.json`, the same **Status hooks** switch as Settings → Agents. A missing value counts as on. New agent tabs read it when they start.
- **The marker**: the file `hooks/.off` in the xDev local folder. Every hook call checks it first, so it quiets agent tabs that are already open.

The hooks are on when the setting is on and the marker is not there.

- `status` prints the state. It changes nothing.
- `on` turns the setting on, then removes the marker.
- `off` writes the marker first, so open tabs stop at once, then turns the setting off.

Every command prints the state after it ran. The text form is three tab-separated lines:

```
on	off
setting	off
marker	on
```

`on` is the result. `setting` is the setting. `marker` is `on` when the marker file is there, that is, when it turns the hooks off.

With `--json` the command prints one JSON object instead:

```json
{"on":false,"setting":false,"marker":true}
```

Turning the hooks on or off changes the command that xDev asks you to approve, so the next start of each agent asks for approval again.

The commands need no running desktop app. Exit codes:

| Code | Meaning |
|---|---|
| 0 | Done. |
| 1 | `error: bad_settings` (the settings file is not a JSON object) or `error: io` (a file cannot be read or written), on stderr. |
| 2 | Wrong arguments. |

### Where the files are

| File | Folder |
|---|---|
| `settings.json` | `XDEV_DATA_DIR` when set; else the OS config folder + `asia.xdev.desktop`. |
| `hooks/.off` | `XDEV_LOCAL_DIR` when set; else `XDEV_DATA_DIR`; else the OS local data folder + `asia.xdev.desktop`. |

## `xdev agent-hook attention`

```
xdev agent-hook attention [--message <text>]
```

Writes an `attention` line for the current agent tab. The tab goes to needs-you, becomes unread when you are not looking, and notifies like any other question, if the **Needs your input** event is on.

- `--message <text>` (or `--message=<text>`) is the notification body. Without it the body is empty. The text is cut at 180 characters.
- It works inside a tab that xDev started. The tab is found from `XDEV_PTY_ID`, which xDev sets for the agent. Outside such a tab, or while the marker `hooks/.off` is there, it writes nothing.
- Like every hook command, it always exits with 0 and prints nothing to stdout, so it never breaks a script. When it cannot write, it prints one line `xdev agent-hook: <reason>` to stderr.

Use it to get a build script, a long job or an agent's own hook to call you:

```
make release && xdev agent-hook attention --message "Release build is ready"
```

Do not put secrets in the message: it goes to the OS notification.

`agent-hook` has other events (`prompt`, `needs-input`, `resume`, `turn-done`, `turn-failed`, `interrupt`). xDev wires them into the agent's own hooks; they are not meant to be called by hand.
