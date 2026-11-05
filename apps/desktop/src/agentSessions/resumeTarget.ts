import type { PtyProfile, SessionRow } from "@/api";

const norm = (path: string) => {
  const p = path.replaceAll("\\", "/").replace(/\/+$/, "");
  // Windows paths compare without case.
  return /^[A-Za-z]:/.test(p) ? p.toLowerCase() : p;
};

const inside = (path: string, root: string) => {
  const a = norm(path);
  const b = norm(root);
  return a === b || a.startsWith(`${b}/`);
};

/**
 * Where a resume runs. The row's own worktree when the registry knows it; else the worktree on screen,
 * with `mismatch` set unless the session's folder is inside it (R4: the CLI may not find the session
 * from another folder, so the person confirms).
 */
export function resumeTarget(row: SessionRow, current: string | null): { worktree: string | null; mismatch: boolean } {
  if (row.worktree) return { worktree: row.worktree, mismatch: false };
  if (!current) return { worktree: null, mismatch: false };
  const cwd = row.session.cwd;
  return { worktree: current, mismatch: !cwd || !inside(cwd, current) };
}

/** The profile and account a session resumes under: the agent's default profile, and its account home. */
export function resumeProfile(row: SessionRow): { profileId: PtyProfile; account: string | null } {
  const { agent, homeId } = row.session;
  return { profileId: agent, account: homeId.startsWith("acct-") ? homeId.slice("acct-".length) : null };
}

/** Where a resume can be sent from the Resume menu: this tab's worktree, the session's own, or a new tab. */
export type ResumeDestination = "here" | "session" | "newTab";

export const RESUME_DESTINATIONS: readonly ResumeDestination[] = ["here", "session", "newTab"];

/** Whether the session's own worktree is known and is not the one on screen. */
export function sessionWorktreeDiffers(row: SessionRow, current: string | null): boolean {
  return !!row.worktree && (!current || norm(row.worktree) !== norm(current));
}

/**
 * The target of a chosen destination. `here` is the worktree on screen (with the same mismatch check as the default);
 * `session` is the row's own worktree and is `null` unless it is known and differs; `newTab` follows the default target.
 */
export function resumeDestination(row: SessionRow, current: string | null, dest: ResumeDestination): { worktree: string | null; mismatch: boolean } {
  if (dest === "here") {
    if (!current) return { worktree: null, mismatch: false };
    const cwd = row.session.cwd;
    return { worktree: current, mismatch: !cwd || !inside(cwd, current) };
  }
  if (dest === "session") return { worktree: sessionWorktreeDiffers(row, current) ? row.worktree : null, mismatch: false };
  return resumeTarget(row, current);
}

/** The three destinations and whether each can run now. */
export function resumeChoices(row: SessionRow, current: string | null): { dest: ResumeDestination; enabled: boolean }[] {
  return RESUME_DESTINATIONS.map((dest) => ({ dest, enabled: resumeDestination(row, current, dest).worktree !== null }));
}
