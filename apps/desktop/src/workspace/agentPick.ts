/** The order `auto` tries the built-in agents in; mirrors `AUTO_ORDER` in `crates/xdev-agent`. */
export const AUTO_ORDER = [
  "claude", "codex", "copilot", "opencode", "gemini", "aider", "goose", "amp", "cursor", "droid", "kimi", "qwen-code", "devin",
] as const;

/** The picker id of the blank terminal (the default shell). */
export const BLANK = "blank";
/** A longer query is cut to this many characters before it is matched. */
export const MAX_QUERY = 2048;
/** Extra words the blank terminal answers to, besides its label. */
const BLANK_WORDS = ["terminal", "shell"];

/**
 * The profile id the default agent starts: the saved agent when it is usable, else the first usable
 * agent of the auto order; `null` (a shell) for `blank` or when nothing is usable.
 */
export function pickAgent(defaultAgent: string, usable: (id: string) => boolean): string | null {
  if (defaultAgent === "blank") return null;
  if (defaultAgent !== "auto" && usable(defaultAgent)) return defaultAgent;
  return AUTO_ORDER.find((id) => usable(id)) ?? null;
}

/** One row the picker can match: the profile id, what it is called and the program it runs. */
export interface AgentEntry {
  id: string;
  label: string;
  command: string;
}

/** The first letters of the words of `text` ("Gemini CLI" → "gc"). */
function acronym(text: string): string {
  return text
    .split(/[\s\-_.]+/)
    .filter((w) => w !== "")
    .map((w) => w[0])
    .join("");
}

/**
 * How well `query` matches an agent; lower is better, `null` is no match. The order: label exact,
 * label prefix, label substring, label acronym, then the id, then the command.
 */
export function scoreAgent(query: string, entry: AgentEntry): number | null {
  const q = query.slice(0, MAX_QUERY).trim().toLowerCase();
  if (q === "") return 0;
  const label = entry.label.toLowerCase();
  if (label === q) return 0;
  if (label.startsWith(q)) return 1;
  if (label.includes(q)) return 2;
  if (acronym(label).startsWith(q)) return 3;
  if (entry.id.toLowerCase().includes(q)) return 4;
  if (entry.command.toLowerCase().includes(q)) return 5;
  return null;
}

/** The blank terminal first, then the agents, best match first; ties keep the given order. */
export function matchAgents(query: string, agents: AgentEntry[], blankLabel: string): AgentEntry[] {
  const blank: AgentEntry = { id: BLANK, label: blankLabel, command: "" };
  const blankScore = [blankLabel, ...BLANK_WORDS]
    .map((label) => scoreAgent(query, { id: BLANK, label, command: "" }))
    .filter((s): s is number => s !== null && s < 4);
  const scored = agents
    .map((entry, at) => ({ entry, at, score: scoreAgent(query, entry) }))
    .filter((x): x is { entry: AgentEntry; at: number; score: number } => x.score !== null)
    .sort((a, b) => a.score - b.score || a.at - b.at)
    .map((x) => x.entry);
  return blankScore.length > 0 ? [blank, ...scored] : scored;
}
