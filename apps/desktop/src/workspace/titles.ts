import type { PtyProfile } from "@/api";
import type { TabCli } from "./sessions";

/** A CLI whose titles carry status glyphs; gemini has no hook caps, so it is not a `TabCli`. */
export type TitleCli = Exclude<TabCli, null> | "gemini";

/** The title CLI of a tab: its hook CLI, or gemini by its profile. */
export const titleCliOf = (cli: TabCli, profileId: PtyProfile): TitleCli | null => cli ?? (profileId === "gemini" ? "gemini" : null);

/** A status a terminal title (OSC 0/2) can say. */
export type TitleStatus = "working" | "needs-you" | "idle";

export interface TitleRule {
  cli: TitleCli;
  /** Tested against the whole title. */
  match: RegExp;
  status: TitleStatus;
}

const SPINNER = /^[\u{2800}-\u{28FF}]/u;
const QUARTER = /[\u{25D0}-\u{25D3}]/u;
// Claude Code's star spinner frames; its resting glyph U+2733 is not one of them.
const CLAUDE_SPINNER = /^[\u{2722}\u{2736}\u{273B}\u{273D}]/u;

/**
 * Glyphs the CLIs put in the terminal title. A Braille spinner frame leads the title while a turn
 * runs; claude rests on U+2733 and spins through other star glyphs; gemini shows U+2726 while it
 * works, U+25C7 when idle and U+270B when it needs input. Titles count only for a pane that has no
 * hook data (see `status.ts`).
 */
export const TITLE_RULES: readonly TitleRule[] = [
  { cli: "claude", match: /^\u{2733}/u, status: "idle" },
  { cli: "claude", match: SPINNER, status: "working" },
  { cli: "claude", match: QUARTER, status: "working" },
  { cli: "claude", match: CLAUDE_SPINNER, status: "working" },
  { cli: "codex", match: SPINNER, status: "working" },
  { cli: "codex", match: QUARTER, status: "working" },
  { cli: "gemini", match: /^\u{2726}/u, status: "working" },
  { cli: "gemini", match: /^\u{25C7}/u, status: "idle" },
  { cli: "gemini", match: /^\u{270B}/u, status: "needs-you" },
];

/** The status a title says for a CLI, or null when no rule matches (or the tab runs no known CLI). */
export function titleStatus(cli: TitleCli | null, title: string, rules: readonly TitleRule[] = TITLE_RULES): TitleStatus | null {
  if (cli === null) return null;
  return rules.find((r) => r.cli === cli && r.match.test(title))?.status ?? null;
}
