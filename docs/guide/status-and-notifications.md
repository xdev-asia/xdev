# Status and notifications

xDev watches each agent tab and shows what it is doing: working, waiting for you, finished, or failed. When something changes in a tab you are not looking at, xDev can tell you through an OS notification, a sound, the header bell and the taskbar badge. Each of these can be turned off, and so can each kind of event.

## Tab states

Each agent tab has one state. The tab and its worktree row in the sidebar show it as a glyph. A plain shell tab shows no glyph.

| State | Glyph | Meaning |
|---|---|---|
| working | spinner | The agent is busy with a turn. |
| needs-you | amber `?` | The agent asks you something, for example to approve a command. |
| done | green check | The agent finished its turn and you have not looked at it yet. |
| idle | gray dot | The agent waits for your next prompt. |
| failed | red dot | The agent's turn ended with an error, or the agent exited with a non-zero or unknown exit code. |
| exited | hollow gray ring | The agent ended normally (exit code 0). The tab shows "Ended" and a Restart chip. |

A worktree row shows the most urgent state of its tabs, in this order: needs-you, failed, done, working, idle, exited. The sidebar groups follow the same states: needs-you and failed go to "Needs you", working to "Running", done to "In review", idle and exited to "Other".

When you type into a tab that is in needs-you, it goes back to working. When you type into a tab whose turn failed, it becomes idle. When you look at a tab that is in done, it becomes idle.

A failed turn is not final: the next prompt starts a new turn. Only a process exit ends a tab (failed with a red dot, or exited).

### Stop, resume and silence

- **Escape or Ctrl-C** in a working tab, or in a tab that waits for you, stops the turn. If no hook says otherwise within 500 ms, the tab goes to idle without any notification. Claude sends no hook for Escape; Codex sends an `interrupt` hook, which settles the tab at once. A turn-done that arrives for a turn you just stopped is not news.
- **Resume.** When a tool runs or you answer a question, the agent tells xDev the turn goes on, and the tab goes back to working.
- **Silence.** A working tab with hooks and no event for 30 minutes goes to idle, quietly. The agent may have been closed or have lost its connection.

## Where the status comes from

xDev uses three sources. A more exact source wins over a less exact one.

1. **Status hooks** (`claude` and `codex` only). The agent CLI runs `xdev agent-hook <event>` at fixed points of its turn:
   - `prompt`: you sent a prompt (working).
   - `needs-input`: the agent waits for you, for example for a permission or an answer (needs-you).
   - `resume`: a tool ran or a question was answered (working).
   - `turn-done`: the turn ended (done).
   - `turn-failed`: the turn ended with an error (failed).
   - `interrupt`: the turn was stopped (idle, quietly). Codex only.
   - `attention`: an agent or a script asked for you on purpose (needs-you). See [the agent hooks CLI](agent-hooks-cli.md).

   Which events a tab reports depends on the agent and its version.
2. **Terminal titles.** Agent CLIs set the terminal title. The title becomes the tab's name, unless you renamed the tab yourself. Some titles also mark a state, for example working or waiting for input.
3. **Output timing.** New output marks a tab working; 3 seconds of quiet marks it idle. The echo of your own typing does not count. This is the only source for agents without hooks or useful titles.

Timing never moves a tab out of needs-you or done. A CLI that redraws its prompt after a turn does not undo the state the hook set.

## Status hooks

Settings → Agents → **Status hooks** turns the hooks on or off. The switch is on by default.

- The hooks are flags on the agent's command line for that one start: `--settings '<json>'` for `claude`, `-c notify=[…]` for `codex`. xDev never writes into the CLIs' config folders, and the CLIs' own settings stay as they are.
- Each hook appends one short line to `hooks/<tab id>.jsonl` in the xDev local folder (`%LOCALAPPDATA%\asia.xdev.desktop` on Windows). xDev reads that folder; there is no network listener.
- A hook always exits with success and prints nothing, so it never blocks or changes the agent's turn.
- The switch applies to new agent tabs only. Tabs that are already open keep the flags they started with. The `xdev agent hooks off` command is different: it takes effect on the next hook call, also in open tabs (see [the agent hooks CLI](agent-hooks-cli.md)).
- The hook flags are part of the command that xDev asks you to approve. When you turn the switch on or off, or when xDev moves to another folder, the next start of each agent asks for approval again.

Hooks are used only when the setting is on **and** the `xdev` CLI is installed next to the desktop app. Otherwise the tab uses titles and output timing.

## Unread

A pane is *seen* when the xDev window has focus, you are present, the workspace view is shown, the pane's worktree is selected and the pane is the active tab (or the second pane of a split).

You are *present* when you pressed a key, clicked or scrolled in xDev within the last 3 minutes. A window that has focus but sits untouched for longer does not count as seen, so an agent that finishes while you are away still notifies you.

- When a tab moves to needs-you, done or failed while it is not seen, it becomes **unread**. A terminal bell in a pane that is not seen also makes it unread, with the reason "bell". Its tab and its worktree row turn bold.
- An unread done tab reads "done, unread" (also for screen readers).
- When the turn ends in a pane you are looking at, the tab goes straight to idle. Nothing is notified and nothing becomes unread.
- Looking at the pane clears its unread mark.
- Right-click a worktree row (or open its `…` menu) and choose **Mark unread** to keep it bold. On a row that is unread the same menu offers **Mark read**. A hand-made mark clears the next time you look at one of its panes.

Unread lives in memory only. It does not survive an app restart.

## Channels

Each time a tab becomes unread, xDev uses the channels that are on. A channel fires only when **both** the switch of the event and the switch of the channel are on, and the master switch is on. All channels are on by default. Every event is on by default except the terminal bell.

By default nothing notifies for a pane you are looking at. Set `suppressWhenFocused` to `false` in the status settings and a seen pane also sends the OS notification and the sound (it still does not become unread). This option has no switch in the app yet.

### OS notification

A system notification. The title holds the worktree, the tab's profile and the state word, for example `oak · Claude Code · Needs you`. The body is what the agent said: the hook's message, else the name of the tool it wants to run, else empty. The worktree is cut at 40 characters, the title at 80 and the body at 180. The body never holds your prompt text. It is shown only when the pane is not seen. Clicking it opens that pane (planned). Where the OS does not report the click, bringing xDev to the front within 15 seconds of the newest notification opens its pane, unless you clicked something in xDev first.

### Sound

A short two-tone beep, or your own sound file. At most one sound plays every 2 seconds, however many tabs change at once.

- Volume: 0 to 100, default 60.
- Own sound: a `wav`, `mp3` or `ogg` file of at most 1 MB. xDev copies it into its data folder (`sounds/custom.<ext>`), so moving or deleting the original later does not matter. Pick a new file to replace it.

### Bell

The bell in the header shows the number of unread tabs (`99+` above 99). Tabs whose event switch is off are not listed. Click it to see the list: worktree, agent, state and how long ago. Click a row to jump to that pane.

### Taskbar badge

The number of worktrees that have an unread tab, on the app's taskbar or dock icon (planned). A worktree counts once, however many of its tabs are unread.

- Windows: a small red dot over the taskbar button while any worktree is unread. Windows shows no number.
- macOS and Linux: the number of unread worktrees on the app icon.

## Settings → Notifications

The Notifications page has:

- A master switch, **Notify me about agents**. Off, no event raises anything, and the badge shows nothing.
- One switch per event: **Needs your input**, **Turn done**, **Turn failed**, **Terminal bell** (off by default). They are disabled while the master switch is off.
- One switch per channel: **OS notification**, **Sound**, **Bell**, **Taskbar badge**.
- **Volume**, saved when you let go of the slider.
- **Use own sound…** opens a file picker. A file of the wrong type or over 1 MB shows "Use a wav, mp3 or ogg file of at most 1 MB."
- **Use default beep** removes your own sound.
- **Test** sends a real OS notification and plays the current sound at the current volume, even when the switches are off. If the OS does not show the notification, a hint tells you to check the system's notification settings for xDev.

The **Status hooks** switch is on the Agents page, not here, because it changes how agents start.

## Troubleshooting

**A `claude` or `codex` tab never shows needs-you or done.**
Hooks need the `xdev` CLI next to the desktop app (the installer puts it there). In a development build, build the CLI next to the desktop executable. Check also that Settings → Agents → Status hooks is on, then open a new agent tab: open tabs keep the flags they started with.

**A `codex` tab never shows needs-you.**
Depending on the Codex version and how it starts, it may report only "turn finished". Then a Codex tab shows needs-you only when its terminal title says so; otherwise it stays working until the turn ends.

**A tab went idle by itself after I pressed Escape.**
That is the stop rule: Escape or Ctrl-C ends the turn, and the tab rests as idle with no notification.

**A tab went idle after a long time with no news.**
A working tab with hooks and no event for 30 minutes rests as idle.

**I am at my desk but xDev still notifies me.**
A pane is seen only while you use xDev. After 3 minutes without a key, click or scroll, the window does not count as watched.

**The agent asks for approval again after I changed Status hooks.**
That is expected. The hook flags are part of the approved command, so a different command needs a new approval.

**No OS notification appears.**
Notifications are shown only for panes you are not looking at. Check that the master switch, the event's switch and the OS notification switch are on, and that the OS allows notifications from xDev. Use Test on the Notifications page.

**My own sound does not play.**
If the file cannot be played, xDev plays the default beep instead. Use Test on the Notifications page to check, or pick the file again.
