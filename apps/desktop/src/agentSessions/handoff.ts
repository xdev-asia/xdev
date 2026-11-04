import { CONTEXT_LINES, lastLines } from "@/terminal/terminalActions";

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
