# Agent hooks CLI

The `xdev` command line has two sets of commands for the status hooks described in [Status and notifications](status-and-notifications.md): one to turn the hooks on or off, and one for an agent or script to ask for you.

## `xdev agent hooks`

```
xdev agent hooks status [--json]
xdev agent hooks on     [--json]
xdev agent hooks off    [--json]
```

The commands read and write the same **Status hooks** setting as Settings → Agents.

- `status` prints whether the hooks are on and whether the live marker is present. It changes nothing.
- `on` turns the hooks on. `off` turns them off.
- `--json` prints one JSON object instead of text, for scripts.

`off` also writes the marker `hooks/.off` in the xDev local folder. Every hook call checks that marker first, so `off` stops hook lines at once, also in agent tabs that are already open. The setting itself still applies to new agent tabs only: a tab keeps the flags it started with. `on` removes the marker.

Turning the hooks on or off changes the command that xDev asks you to approve, so the next start of each agent asks for approval again.

The commands exit with 0 when they succeed and with a non-zero code when the setting cannot be read or written. They need no running desktop app.

## `xdev agent-hook attention`

```
xdev agent-hook attention [--message <text>]
```

Writes an `attention` line for the current agent tab. The tab goes to needs-you, becomes unread when you are not looking, and notifies like any other question, if the **Needs your input** event is on.

- `--message <text>` is the notification body. Without it the body is empty. The text is cut at 180 characters.
- It works inside a tab that xDev started with hooks on. The tab is found from the environment that xDev gives the agent. Outside such a tab the command does nothing.
- Like every hook command, it exits with success and prints nothing, so it never breaks a script.

Use it to get a build script, a long job or an agent's own hook to call you:

```
make release && xdev agent-hook attention --message "Release build is ready"
```

Do not put secrets in the message: it goes to the OS notification.
