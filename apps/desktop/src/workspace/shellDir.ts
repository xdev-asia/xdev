/**
 * `abs` relative to `worktree`, with `/` between folders: "" for the worktree itself, null outside it.
 * Either slash works, `.` and `..` are folded, and a path that starts with a drive letter compares
 * without case, as Windows does.
 */
export function dirInside(worktree: string, abs: string): string | null {
  const w = segments(worktree);
  const a = segments(abs);
  if (!w || !a || w.length === 0 || a.length < w.length) return null;
  const fold = /^[A-Za-z]:$/.test(w[0]!) ? (s: string) => s.toLowerCase() : (s: string) => s;
  for (let i = 0; i < w.length; i++) if (fold(w[i]!) !== fold(a[i]!)) return null;
  return a.slice(w.length).join("/");
}

function segments(path: string): string[] | null {
  const out: string[] = [];
  for (const s of path.replace(/\\/g, "/").split("/")) {
    if (s === "" || s === ".") continue;
    if (s !== "..") out.push(s);
    else if (out.pop() === undefined) return null;
  }
  return out;
}
