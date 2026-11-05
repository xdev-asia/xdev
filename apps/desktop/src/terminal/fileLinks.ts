// Finds `path[:line[:col]]` in a line of terminal text. A candidate is only a guess: the backend
// decides whether it names a file inside the worktree. The scan is linear (one pass over the
// whitespace-separated tokens, a few character-class tests each), so a very long line stays cheap.

export type FileLink = {
  // The path as printed, without `:line:col`; `file://` stays in.
  path: string;
  line?: number;
  column?: number;
  // UTF-16 offsets into the scanned line: the path and its `:line:col`, end exclusive.
  start: number;
  end: number;
};

// Longest token tried as a path with a separator, and as a bare file name.
const MAX_TOKEN = 1024;
const BARE_MAX = 100;
const BARE_MIN = 2;
const KNOWN_NAMES = new Set(["Makefile", "Dockerfile", "Rakefile", "Gemfile", "Procfile", "LICENSE", "README", "CHANGELOG", "AUTHORS", "NOTICE", "CONTRIBUTING"]);

// A path with a separator: how it starts, and what the rest may hold.
const START = /^(?:~\/|\/|\.\/|\.\.\/|[A-Za-z]:[\\/]|[\p{L}\p{N}\p{M}_.-]+[\\/])/u;
const BODY = /^[\p{L}\p{N}\p{M}._~\-/%+@\\()[\]・･〜～]+$/u;
const BARE = /^[A-Za-z0-9_][A-Za-z0-9._+-]*$/;
const FILE_URI = /^file:\/\/[^\s]+$/i;
const OPENERS = new Set(["(", "[", "{", '"', "'"]);
const PAIRS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
const ALWAYS_TRAILING = new Set(['"', "'", ",", ";", ".", ":"]);

function trimmed(token: string, from: number): { text: string; start: number } {
  let start = 0;
  while (start < token.length && OPENERS.has(token[start]!)) start++;
  let end = token.length;
  while (end > start) {
    const c = token[end - 1]!;
    if (ALWAYS_TRAILING.has(c)) {
      end--;
      continue;
    }
    const open = PAIRS[c];
    if (open !== undefined && !balanced(token.slice(start, end), open, c)) {
      end--;
      continue;
    }
    break;
  }
  return { text: token.slice(start, end), start: from + start };
}

// True when `text` has an opener for its last closer.
function balanced(text: string, open: string, close: string): boolean {
  let depth = 0;
  for (const c of text) {
    if (c === open) depth++;
    else if (c === close) depth--;
  }
  return depth >= 0;
}

/**
 * `src/a.ts:12:5` as `{ path, line, column }`. The colon of a drive (`C:\x`) is not a line suffix;
 * a line or column below 1, or past the safe integers, makes the whole text no location (null).
 */
export function parseLocation(text: string): { path: string; line?: number; column?: number } | null {
  let path = text;
  const nums: number[] = [];
  for (let i = 0; i < 2; i++) {
    const m = /:(\d+)$/.exec(path);
    if (!m) break;
    const n = Number(m[1]);
    if (!Number.isSafeInteger(n) || n < 1) return null;
    nums.unshift(n);
    path = path.slice(0, m.index);
  }
  // `C:12` is not a drive path and `C:` alone is not a path; callers check the start.
  if (path === "") return null;
  const [line, column] = nums;
  return { path, ...(line !== undefined ? { line } : {}), ...(column !== undefined ? { column } : {}) };
}

/** `path:line[:col]`, as a terminal prints it. A column without a line is dropped. */
export function formatLocation(path: string, line?: number, column?: number): string {
  if (line === undefined) return path;
  return column === undefined ? `${path}:${line}` : `${path}:${line}:${column}`;
}

function looksLikePath(path: string): boolean {
  if (path.endsWith("/") || path.endsWith("\\")) return false;
  if (FILE_URI.test(path)) return true;
  if (path.includes("://")) return false;
  // The colon of a drive is the one `:` a path may hold.
  if (!BODY.test(path.replace(/^[A-Za-z]:(?=[\\/])/, ""))) return false;
  if (/[\\/]/.test(path)) return START.test(path);
  return looksLikeFileName(path);
}

function looksLikeFileName(name: string): boolean {
  if (name.length < BARE_MIN || name.length > BARE_MAX || !BARE.test(name)) return false;
  if (/^\d+$/.test(name)) return false;
  return KNOWN_NAMES.has(name) || (name.includes(".") && /[^.]/.test(name) && !name.endsWith("."));
}

/** The file path candidates in `line`, in order. */
export function findFileLinks(line: string): FileLink[] {
  const out: FileLink[] = [];
  for (const m of line.matchAll(/\S+/g)) {
    const token = m[0];
    if (token.length > MAX_TOKEN) continue;
    const { text, start } = trimmed(token, m.index);
    if (text === "") continue;
    const at = parseLocation(text);
    if (at === null) continue;
    // `http://h/a/b` and any other `scheme://` is not a path; `file://` is.
    if (!looksLikePath(at.path)) continue;
    out.push({ path: at.path, ...(at.line !== undefined ? { line: at.line } : {}), ...(at.column !== undefined ? { column: at.column } : {}), start, end: start + text.length });
  }
  return out;
}
