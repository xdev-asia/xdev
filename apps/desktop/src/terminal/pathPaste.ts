export type ShellKind = "posix" | "fish" | "powershell" | "cmd" | "unknown";

export const IMAGE_EXTENSIONS: readonly string[] = [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".ico"];

// C0, DEL, C1 and the Unicode line and paragraph separators: never part of a pasted path.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;
// Characters every supported shell reads as plain text.
// Non-ASCII letters stay bare; Unicode spaces (NBSP, U+2000 range, U+3000) are escaped like a space.
const BARE_POSIX = /^(?:[a-zA-Z0-9_./@:\-]|[^\x00-\x7f\s])+$/;
// ASCII only: PowerShell reads NBSP and other Unicode spaces as whitespace, an en dash as a parameter
// marker, and U+2018 to U+201E as quotes. `@` opens a splat there. Everything else is quoted.
const BARE_WINDOWS = /^[a-zA-Z0-9_./:\\-]+$/;
const POSIX_ESCAPE = /(?![a-zA-Z0-9_./@:\-])(?:[\x00-\x7f]|\s)/g;

const SHELL_PROGRAMS: Record<string, ShellKind> = {
  pwsh: "powershell",
  powershell: "powershell",
  cmd: "cmd",
  fish: "fish",
  bash: "posix",
  sh: "posix",
  zsh: "posix",
  dash: "posix",
  ksh: "posix",
  ash: "posix",
  wsl: "posix",
};

/**
 * The quoting kind of a pane from the program it runs. An agent CLI is no shell: it reads the path
 * as text, backslash-escaped on unix and double-quoted on Windows. Any other program is unknown.
 */
export function shellKindFor(program: string, agent: boolean, windows: boolean): ShellKind {
  if (agent) return windows ? "cmd" : "posix";
  const base = (program.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.(exe|com|bat|cmd)$/, "");
  return SHELL_PROGRAMS[base] ?? "unknown";
}

/** An image by the extension of its last path segment, any case. */
export function isImagePath(path: string): boolean {
  const base = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  return dot >= 0 && IMAGE_EXTENSIONS.includes(base.slice(dot).toLowerCase());
}

/**
 * The path as one word for `kind`: bare when plain, else escaped (posix, fish) or quoted
 * (PowerShell, cmd). null when the path cannot be written safely: a control character in it, a
 * `%`, `!` or `"` for cmd (it would expand inside quotes), or any special character for an unknown shell.
 */
export function quotePath(path: string, kind: ShellKind): string | null {
  if (path === "" || CONTROL.test(path)) return null;
  switch (kind) {
    case "posix":
    case "fish":
      return BARE_POSIX.test(path) ? path : path.replace(POSIX_ESCAPE, (c) => `\\${c}`);
    case "powershell":
      return BARE_WINDOWS.test(path) ? path : `'${path.replace(/['\u2018\u2019\u201a\u201b]/g, (c) => c + c)}'`;
    case "cmd":
      if (/[%!"]/.test(path)) return null;
      if (BARE_WINDOWS.test(path)) return path;
      // A trailing backslash would escape the closing quote for a program that parses its argv.
      return `"${path.replace(/(\\+)$/, "$1$1")}"`;
    default:
      return BARE_WINDOWS.test(path) ? path : null;
  }
}

/** `ESC[200~` + text without ESC and C0 controls except tab + `ESC[201~`. */
export function bracketed(text: string): string {
  // eslint-disable-next-line no-control-regex
  return `\x1b[200~${text.replace(/[\x00-\x08\x0a-\x1f\x7f]/g, "")}\x1b[201~`;
}

/**
 * One write per dropped path, in order. An image goes in as a bracketed paste when the program
 * turned that mode on (an agent CLI reads it as an attachment), anything else as a quoted word. A space follows each, except between two
 * images pasted as they are. A path that cannot be quoted safely is left out and counted.
 */
export function dropPayloads(
  paths: readonly string[],
  kind: ShellKind,
  bracketedMode = true,
): { payloads: string[]; rejected: number } {
  const parts: { data: string; rawImage: boolean }[] = [];
  let rejected = 0;
  for (const path of paths) {
    const word = quotePath(path, kind);
    if (word === null) {
      rejected++;
      continue;
    }
    if (isImagePath(path) && bracketedMode) parts.push({ data: bracketed(word), rawImage: word === path });
    else parts.push({ data: word, rawImage: false });
  }
  const payloads = parts.map((part, i) => (part.rawImage && parts[i + 1]?.rawImage ? part.data : `${part.data} `));
  return { payloads, rejected };
}
