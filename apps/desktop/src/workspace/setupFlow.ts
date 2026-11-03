import type { RepoHooks } from "@/api";

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
