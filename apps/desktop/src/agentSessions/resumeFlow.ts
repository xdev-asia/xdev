import type { SessionRow } from "@/api";
import type { Sessions, Tab } from "@/workspace/sessions";
import { resumeDestination, resumeProfile, resumeTarget, type ResumeDestination } from "./resumeTarget";

/** A resume that waits for the person to accept running in another folder. */
export type PendingResume = { row: SessionRow; worktree: string };

/**
 * Opens the resume tab at once, or hands `ask` the folder mismatch to confirm; `null` when it asked or has no target.
 * `dest` is a destination picked from the Resume menu; without it the default target applies.
 */
export function startResume(
  sessions: Sessions,
  row: SessionRow,
  current: string | null,
  ask: (pending: PendingResume) => void,
  dest?: ResumeDestination,
): Tab | null {
  const { worktree, mismatch } = dest ? resumeDestination(row, current, dest) : resumeTarget(row, current);
  if (!worktree) return null;
  if (mismatch) {
    ask({ row, worktree });
    return null;
  }
  return confirmResume(sessions, { row, worktree });
}

/** Opens the agent tab for a row in a worktree, titled with the session's first prompt. */
export function confirmResume(sessions: Sessions, pending: PendingResume): Tab {
  const { row, worktree } = pending;
  const { profileId, account } = resumeProfile(row);
  return sessions.resume(worktree, profileId, account, row.session.id, row.session.title);
}
