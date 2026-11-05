// Paths for links and for copy: an absolute path as a worktree-relative one, and the other way
// round with the OS's separators. Pure string work; the backend still checks every path it opens.
import { PLATFORM } from "@/platform";

const DRIVE = /^[A-Za-z]:(?=[\\/]|$)/;

/** True for `/x`, `X:\x` and `X:/x` (a drive path), and for `\\server\share`. */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\\\") || DRIVE.test(path);
}

// The parts of an absolute path, `.` and empty ones dropped and `..` folded; null when `..` climbs out of the root.
function partsOf(path: string): { root: string; names: string[] } | null {
  const drive = DRIVE.exec(path)?.[0] ?? "";
  const rest = path.slice(drive.length).replace(/\\/g, "/");
  const names: string[] = [];
  for (const part of rest.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (names.pop() === undefined) return null;
      continue;
    }
    names.push(part);
  }
  return { root: drive.toUpperCase(), names };
}

/**
 * `abs` as a path relative to `worktree` with `/`, or null when it is not strictly inside.
 * Case is folded for the drive letter and the names on Windows and macOS (`fold`), as their
 * volumes usually do; the returned names keep the case `abs` has.
 */
export function relUnder(worktree: string, abs: string, fold: boolean = PLATFORM !== "linux"): string | null {
  // A canonical Windows worktree (`\\?\E:\x`) reads as its plain spelling.
  const root = worktree.replace(/^\\\\\?\\/, "");
  if (!isAbsolutePath(abs) || abs.startsWith("\\\\") || root.startsWith("\\\\")) return null;
  const a = partsOf(abs);
  const b = partsOf(root);
  if (!a || !b || a.root !== b.root || a.names.length <= b.names.length) return null;
  const same = (x: string, y: string) => (fold ? x.toLowerCase() === y.toLowerCase() : x === y);
  if (!b.names.every((name, i) => same(name, a.names[i]!))) return null;
  return a.names.slice(b.names.length).join("/");
}

/** `path` with the separators of the OS: `\` on Windows, as the OS prints a path. */
export function toNative(path: string, win: boolean = PLATFORM === "win"): string {
  return win ? path.replace(/\//g, "\\") : path;
}

/** `<absolute path>:<line>` as the OS prints it; `worktree` and `rel` use `/` or the OS's own. */
export function pathToLine(worktree: string, rel: string, line: number, win: boolean = PLATFORM === "win"): string {
  const base = worktree.replace(/[\\/]+$/, "");
  return `${toNative(`${base}/${rel}`, win)}:${line}`;
}
