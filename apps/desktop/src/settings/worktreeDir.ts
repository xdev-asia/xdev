import { isAbsolutePath } from "@/files/linkPath";

/** Most folders `worktreeDirHistory` keeps, as `WORKTREE_DIR_HISTORY_MAX` in the desktop. */
export const WORKTREE_DIR_HISTORY_MAX = 5;

/** `history` with `dir` first: trimmed, once, at most five. A blank or relative `dir` leaves it as it is. */
export function pushDirHistory(history: string[], dir: string): string[] {
  const d = dir.trim();
  const next = d !== "" && isAbsolutePath(d) ? [d, ...history.filter((h) => h.trim() !== d)] : history;
  return next.slice(0, WORKTREE_DIR_HISTORY_MAX);
}

/** What a typed worktree folder is stored as: trimmed, or "bad" when it is not empty and not absolute. */
export function worktreeDirOf(text: string): string | "bad" {
  const d = text.trim();
  return d === "" || isAbsolutePath(d) ? d : "bad";
}
