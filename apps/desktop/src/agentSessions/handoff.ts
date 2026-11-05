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
  /** The conversation text from `transcriptText`; when set it stands in for the terminal lines. */
  transcript?: string;
}

/**
 * The prompt that gives another agent the state of a session: who worked, where, the first request and
 * the last lines of the terminal (the same cap as Copy Context). Plain text; `pastePrompt` drops the
 * control characters when it is typed in.
 */
export function handoffPrompt(input: HandoffInput): string {
  const where = input.branch ? `${input.worktree} (${input.branch})` : input.worktree;
  const tail = lastLines(input.lines, CONTEXT_LINES);
  if (input.transcript !== undefined && input.transcript !== "") {
    return [
      `Another agent (${input.fromProfile}) worked on this task and you are taking it over.`,
      `Worktree: ${where}`,
      "--- its conversation so far, oldest first ---",
      input.transcript,
      "--- end ---",
      "Read the state of the work from this and continue it.",
    ].join("\n");
  }
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

/** The most characters of conversation text a full-transcript hand-off carries. */
export const TRANSCRIPT_MAX = 8000;
/** The first line of a transcript that had its older turns cut. */
export const CUT_MARK = "[earlier turns cut]";

export interface TranscriptTurn {
  /** `user`; any other value reads as the agent. */
  role: string;
  text: string;
}

/**
 * The turns as `User: …` and `Agent: …` blocks, oldest first, at most `max` characters. The newest turns
 * are kept whole; when older ones do not fit the text starts with `CUT_MARK`. A newest turn longer than the
 * room keeps its end. No turns (or only blank ones) give an empty string.
 */
export function transcriptText(turns: TranscriptTurn[], max: number = TRANSCRIPT_MAX): string {
  const blocks = turns.map((t) => ({ role: t.role, text: t.text.trim() })).filter((t) => t.text !== "").map((t) => `${t.role === "user" ? "User" : "Agent"}: ${t.text}`);
  if (blocks.length === 0) return "";
  const join = (parts: string[]) => parts.join("\n\n");
  if (join(blocks).length <= max) return join(blocks);
  const room = max - CUT_MARK.length - 2;
  const kept: string[] = [];
  let used = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    const cost = block.length + (kept.length > 0 ? 2 : 0);
    if (used + cost > room) {
      if (kept.length === 0) kept.unshift(Array.from(block).slice(-Math.max(room, 0)).join(""));
      break;
    }
    kept.unshift(block);
    used += cost;
  }
  return `${CUT_MARK}\n\n${join(kept)}`;
}
