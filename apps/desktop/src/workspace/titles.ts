import type { TabCli } from "./sessions";

/** A status a terminal title (OSC 0/2) can say. */
export type TitleStatus = "working" | "needs-you" | "idle";

export interface TitleRule {
  cli: Exclude<TabCli, null>;
  /** Tested against the whole title. */
  match: RegExp;
  status: TitleStatus;
}

/**
 * Titles the CLIs are known to set, and what each says. Empty on purpose: the Task 1 spike did not
 * record real titles from the installed `claude` and `codex` (print mode sets none), so no rule can
 * be stated as fact yet. Add a row only for a title string seen on a real interactive launch.
 * Titles count only for a pane that has no hook data (see `status.ts`).
 */
export const TITLE_RULES: readonly TitleRule[] = [];

/** The status a title says for a CLI, or null when no rule matches (or the tab runs no known CLI). */
export function titleStatus(cli: TabCli, title: string, rules: readonly TitleRule[] = TITLE_RULES): TitleStatus | null {
  if (cli === null) return null;
  return rules.find((r) => r.cli === cli && r.match.test(title))?.status ?? null;
}
