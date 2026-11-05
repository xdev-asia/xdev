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
 * Glyphs the CLIs put in the terminal title: a Braille spinner frame or a quarter circle while a turn
 * runs, and a leading U+2733 for a resting claude. Titles count only for a pane that has no hook data
 * (see `status.ts`).
 */
export const TITLE_RULES: readonly TitleRule[] = [
  { cli: "claude", match: /[\u{2800}-\u{28FF}\u{25D0}-\u{25D3}]/u, status: "working" },
  { cli: "codex", match: /[\u{2800}-\u{28FF}\u{25D0}-\u{25D3}]/u, status: "working" },
  { cli: "claude", match: /^\u{2733}/u, status: "idle" },
];

/** The status a title says for a CLI, or null when no rule matches (or the tab runs no known CLI). */
export function titleStatus(cli: TabCli, title: string, rules: readonly TitleRule[] = TITLE_RULES): TitleStatus | null {
  if (cli === null) return null;
  return rules.find((r) => r.cli === cli && r.match.test(title))?.status ?? null;
}
