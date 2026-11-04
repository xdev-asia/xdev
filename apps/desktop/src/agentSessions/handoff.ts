import type { Api } from "@/api";
import { CONTEXT_LINES, lastLines } from "@/terminal/terminalActions";

/** The longest first prompt a hand-off carries, in code points. */
export const FIRST_PROMPT_MAX = 500;

/**
 * The first prompt of a session, from the session index (the same query as the auto tab title), cut to
 * 500 code points. `null` when the session is unknown, the index has no prompt, or the lookup fails.
 * It never reads the tab title, which may have been typed by hand.
 */
export async function sourceFirstPrompt(api: Pick<Api, "agentSessions">, worktree: string, session: string | null): Promise<string | null> {
  if (!session) return null;
  try {
    const rows = await api.agentSessions({ text: session, scope: { kind: "worktree", path: worktree }, agent: null, homeId: null, sort: "lastDesc", limit: 1 }, true);
    const title = rows.find((r) => r.session.id === session)?.session.title?.trim();
    return title ? Array.from(title).slice(0, FIRST_PROMPT_MAX).join("") : null;
  } catch {
    return null;
  }
}

export interface HandoffInput {
  /** The name of the agent that worked so far. */
  fromProfile: string;
  worktree: string;
  branch: string | null;
  /** The first prompt of that session, when known. */
  firstPrompt: string | null;
  /** The screen text of the source terminal, oldest first. */
  lines: string[];
}

/**
 * The prompt that gives another agent the state of a session: who worked, where, the first request and
 * the last lines of the terminal (the same cap as Copy Context). Plain text; `pastePrompt` drops the
 * control characters when it is typed in.
 */
export function handoffPrompt(input: HandoffInput): string {
  const where = input.branch ? `${input.worktree} (${input.branch})` : input.worktree;
  const tail = lastLines(input.lines, CONTEXT_LINES);
  return [
    `Another agent (${input.fromProfile}) worked on this task and you are taking it over.`,
    `Worktree: ${where}`,
    ...(input.firstPrompt ? [`Its first request: ${input.firstPrompt}`] : []),
    `--- last ${CONTEXT_LINES} lines of its terminal ---`,
    ...tail,
    "--- end ---",
    "Read the state of the work from this and continue it.",
  ].join("\n");
}
