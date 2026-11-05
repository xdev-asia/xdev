# Terminal links

A file path or a URL in terminal output is a link. Hover it to see what a click does.

## File paths

A path such as `src/a.ts:12:5` becomes a link when it names an existing file inside the worktree of that terminal tab. Relative paths resolve against the worktree root. Files outside the worktree stay plain text.

| Gesture | Result |
|---|---|
| Click | Depends on the setting below: action menu, open, or nothing. |
| Ctrl+click (⌘+click on macOS) | Opens the file in the editor at the line and column. |
| Shift+Ctrl+click (⇧⌘+click on macOS) | Opens the file with the default app. |
| Alt held | Selects text as usual. |

The action menu offers Open file, Open with default app, Reveal in file manager, Copy file path and Terminal link settings. A file that can run as a program (for example `.exe`, `.bat`, or a file with an execute bit) is never opened with the default app.

## URLs and OSC 8 hyperlinks

An `http` or `https` URL opens in the system browser. A middle click on a URL follows its own setting. Hyperlinks written with the OSC 8 escape sequence follow the same rules: `http(s)` opens in the browser, `file://` and plain paths open in the editor, other schemes do nothing.

When a program tracks the mouse (vim, htop), hold Shift to click a link.

## Settings

Settings, Terminal, Links:

- When you click a link: Show actions (default), Open, or Do nothing.
- When you middle-click a URL: Open (default), Show actions, or Do nothing.

## Editor gutter and quick open

Right-click a line number in a file tab for Copy path to line, Copy relative path to line and Copy remote URL (GitHub, GitLab or Bitbucket). Quick open accepts `path:line:col` and absolute paths inside the current worktree.
