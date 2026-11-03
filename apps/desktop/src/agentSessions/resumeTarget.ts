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
