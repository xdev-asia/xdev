import type { PtyProfile, SequenceStep, SetEntry, SetWorktree, TerminalSet } from "@/api";
import { TERMINAL_SET_LIMITS } from "./limits";

/** The part of a tab a set captures. */
export interface CaptureTab {
  id: string;
  worktree: string;
  profileId: PtyProfile;
  agent: boolean;
  exitCode?: number | null;
}

/**
 * The entries that would reopen `tabs`: an agent tab becomes an agent entry, any other a plain shell
 * entry of the same shell. A tab of `current` is saved as "current"; one of another worktree by the
 * label `labelOf` gives (it is left out when it has none). Exited tabs are left out. `startupOf` gives the
 * sequence a tab was started with. At most `TERMINAL_SET_LIMITS.entries` come back.
 */
export function captureEntries(
  tabs: readonly CaptureTab[],
  current: string,
  labelOf: (path: string) => string | null,
  startupOf: (tabId: string) => readonly SequenceStep[] = () => [],
): SetEntry[] {
  const out: SetEntry[] = [];
  for (const tab of tabs) {
    if (tab.exitCode !== undefined) continue;
    let worktree: SetWorktree = { type: "current" };
    if (tab.worktree !== current) {
      const name = labelOf(tab.worktree);
      if (name === null) continue;
      worktree = { type: "named", name };
    }
    out.push({
      target: tab.agent ? { type: "agent", profile: tab.profileId } : { type: "shell", command: "", shell: tab.profileId },
      worktree,
      startup: structuredClone([...startupOf(tab.id)]),
    });
  }
  return out.slice(0, TERMINAL_SET_LIMITS.entries);
}

/** A set to save from the open tabs; `id` empty asks the store for a new one. */
export const newSet = (name: string, entries: SetEntry[]): TerminalSet => ({ id: "", name: name.trim(), entries });

/** The worktree path an entry opens in, or null when its name is not among `worktrees`. */
export function resolveWorktree(w: SetWorktree, current: string, worktrees: readonly { path: string; label: string }[]): string | null {
  if (w.type === "current") return current;
  const want = w.name.trim().toLowerCase();
  return worktrees.find((x) => x.label.toLowerCase() === want)?.path ?? null;
}

/** One line for an entry: the agent id, or the command (or "shell" when it has none). */
export function entrySummary(entry: SetEntry, shellWord: string): string {
  if (entry.target.type === "agent") return entry.target.profile;
  return entry.target.command.trim() === "" ? shellWord : entry.target.command.split(/\r?\n/)[0];
}

/** An empty new entry for the editor. */
export const blankEntry = (profile: string | null): SetEntry => ({
  target: profile === null ? { type: "shell", command: "", shell: null } : { type: "agent", profile },
  worktree: { type: "current" },
  startup: [],
});
