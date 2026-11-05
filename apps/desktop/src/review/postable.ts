import type { ReviewData, ReviewNote } from "@/api";

/** Why a local note cannot go to the PR yet: `push` (the PR lacks these lines) or `unknown` (its head could not be read). */
export type PostBlock = "push" | "unknown";

/**
 * A note's line numbers are the worktree's. They only mean the same lines on the PR when the worktree
 * `HEAD` is the PR head and the note's file has no uncommitted change. `null` means the note can go.
 */
export function postBlock(
  note: Pick<ReviewNote, "file">,
  data: Pick<ReviewData, "headOid" | "files"> | null,
  prHead: string | null,
): PostBlock | null {
  if (prHead === null || data === null) return "unknown";
  if (data.headOid !== prHead) return "push";
  const file = data.files.find((f) => f.path === note.file);
  return file && (file.staged || file.unstaged) ? "push" : null;
}
