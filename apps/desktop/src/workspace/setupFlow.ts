import type { DefaultTab, RepoHooks } from "@/api";

/** What the shell does for a new worktree, from what `repoHooks` says. */
export type SetupStep =
  | { step: "none" }
  | { step: "detected"; command: string }
  | { step: "ask" }
  | { step: "run" }
  | { step: "trust" };

/** Skip never runs and never opens the setup tab; Ask offers; Run goes ahead once trusted. */
export function decideSetup(hooks: RepoHooks): SetupStep {
  if (!hooks.setup) return hooks.detected ? { step: "detected", command: hooks.detected } : { step: "none" };
  if (hooks.policy === "skip") return { step: "none" };
  if (hooks.policy === "ask") return { step: "ask" };
  return hooks.setup.trusted ? { step: "run" } : { step: "trust" };
}

/** The shared paths and default tabs the person has not trusted yet; each hash is null when that list needs nothing. */
export interface PendingLists {
  shared: string[];
  sharedHash: string | null;
  tabs: DefaultTab[];
  tabsHash: string | null;
}

export function pendingLists(hooks: RepoHooks): PendingLists {
  const shared = hooks.sharedHash !== null && !hooks.sharedTrusted;
  const tabs = hooks.tabsHash !== null && !hooks.tabsTrusted;
  return {
    shared: shared ? hooks.shared : [],
    sharedHash: shared ? hooks.sharedHash : null,
    tabs: tabs ? hooks.tabs : [],
    tabsHash: tabs ? hooks.tabsHash : null,
  };
}

export const hasPending = (lists: PendingLists): boolean => lists.sharedHash !== null || lists.tabsHash !== null;
