// The pure side of the conversation view: rows from items, pages merged, the reader preferences.
import type { Conversation, ConversationEntry, ConversationSubagent } from "@/api";

/** Items one page asks for, as the Rust default. */
export const PAGE = 200;

/** One row of the chat list: a message, a marker, or a run of tool steps folded together. */
export type Row =
  | { kind: "user" | "assistant"; key: string; item: ConversationEntry }
  | { kind: "marker"; key: string; item: ConversationEntry }
  | { kind: "tools"; key: string; items: ConversationEntry[] }
  /** The tool step that started a sub-agent: its own row, folded, with the run's steps and result. */
  | { kind: "subagent"; key: string; item: ConversationEntry };

const KNOWN = new Set(["user", "assistant", "tool", "marker"]);

/**
 * The rows of `items`: each run of tool steps next to each other becomes one row. A kind this view does not know
 * (a later one) is skipped, and does not split a run. A step that started a sub-agent is a row of its own.
 */
export function foldRows(items: readonly ConversationEntry[]): Row[] {
  const rows: Row[] = [];
  let run: ConversationEntry[] | null = null;
  for (const item of items) {
    if (!KNOWN.has(item.kind)) continue;
    if (item.kind === "tool" && item.subagent) {
      run = null;
      rows.push({ kind: "subagent", key: `s${item.index}`, item });
      continue;
    }
    if (item.kind === "tool") {
      if (run) run.push(item);
      else {
        run = [item];
        rows.push({ kind: "tools", key: `t${item.index}`, items: run });
      }
      continue;
    }
    run = null;
    if (item.kind === "marker") rows.push({ kind: "marker", key: `m${item.index}`, item });
    else rows.push({ kind: item.kind as "user" | "assistant", key: `i${item.index}`, item });
  }
  return rows;
}

/** What the view holds: the loaded run of items (by index, no gaps) and the facts of the whole session. */
export interface Loaded {
  items: ConversationEntry[];
  total: number;
  turns: number;
  agent: string;
  model: string | null;
  markers: ConversationEntry[];
  /** The session's sub-agent runs, whatever the page. */
  subagents: ConversationSubagent[];
}

/** Index of the first loaded item; `total` when none is loaded. */
export function firstIndex(l: Loaded): number {
  return l.items[0]?.index ?? l.total;
}

/** True when older items than the loaded ones exist. */
export function hasOlder(l: Loaded): boolean {
  return firstIndex(l) > 0;
}

/** The `from` and `limit` of the page just before the loaded items. */
export function olderPage(l: Loaded, size = PAGE): { from: number; limit: number } {
  const first = firstIndex(l);
  const from = Math.max(0, first - size);
  return { from, limit: Math.max(1, first - from) };
}

/**
 * `page` merged into `prev`: items of the same index are replaced (a step that ended), new ones join. A page
 * that does not touch the loaded run (more came in than one page holds) replaces it.
 */
export function mergePage(prev: Loaded | null, page: Conversation): Loaded {
  const facts = { total: page.total, turns: page.turns, agent: page.agent, model: page.model, markers: page.markers, subagents: page.subagents ?? [] };
  const fresh = page.items.filter((i) => i.index < page.total);
  if (!prev || prev.items.length === 0) return { ...facts, items: fresh };
  const first = firstIndex(prev);
  const last = first + prev.items.length; // exclusive
  const pageFirst = fresh[0]?.index ?? page.from;
  const pageEnd = pageFirst + fresh.length;
  if (fresh.length > 0 && (pageFirst > last || pageEnd < first)) return { ...facts, items: fresh };
  const byIndex = new Map<number, ConversationEntry>();
  for (const i of prev.items) if (i.index < page.total) byIndex.set(i.index, i);
  for (const i of fresh) byIndex.set(i.index, i);
  const items = [...byIndex.values()].sort((a, b) => a.index - b.index);
  return { ...facts, items };
}

/** The tool steps of a run that failed. */
export function failedSteps(items: readonly ConversationEntry[]): number {
  return items.filter((i) => i.tool?.status === "error").length;
}

// Reader preferences, kept per user on this machine.
export type ViewMode = "chat" | "reader";
export type TextSize = "small" | "medium" | "large";
export const TEXT_SIZES: readonly TextSize[] = ["small", "medium", "large"];
const PREFS_KEY = "xdev.conversation.v1";

export interface ConversationPrefs {
  mode: ViewMode;
  size: TextSize;
}

export const DEFAULT_PREFS: ConversationPrefs = { mode: "chat", size: "medium" };

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The stored preferences; anything unreadable falls back to the defaults. */
export function readPrefs(): ConversationPrefs {
  try {
    const raw = storage()?.getItem(PREFS_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<ConversationPrefs>) : {};
    return {
      mode: v.mode === "reader" ? "reader" : "chat",
      size: TEXT_SIZES.includes(v.size as TextSize) ? (v.size as TextSize) : DEFAULT_PREFS.size,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function writePrefs(p: ConversationPrefs): void {
  try {
    storage()?.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // A full or blocked storage keeps the choice for this session only.
  }
}

/** One step smaller or larger, held to the three sizes. */
export function stepSize(size: TextSize, by: -1 | 1): TextSize {
  const i = TEXT_SIZES.indexOf(size) + by;
  return TEXT_SIZES[Math.min(Math.max(i, 0), TEXT_SIZES.length - 1)]!;
}

/** True when the list is scrolled to (within a few px of) its end. */
export function atBottom(el: { scrollTop: number; scrollHeight: number; clientHeight: number }, slack = 24): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}

/** Pane width from which the view sits beside the terminal instead of over it. */
export const SPLIT_MIN_PX = 900;

/** The run a sub-agent row stands for, by the call id its step names. */
export function runOf(l: Pick<Loaded, "subagents">, item: Pick<ConversationEntry, "subagent">): ConversationSubagent | null {
  return item.subagent ? (l.subagents.find((r) => r.id === item.subagent) ?? null) : null;
}

/**
 * The text a follow-up about a sub-agent's result starts with, for the composer. The CLI cannot send to a
 * sub-agent that ended, so the follow-up goes to the main agent and names the run.
 */
export function followUpText(run: Pick<ConversationSubagent, "description" | "result">, template: (vars: { description: string; result: string }) => string, max = 280): string {
  const flat = run.result.replace(/\s+/g, " ").trim();
  const result = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  return template({ description: run.description, result });
}

/**
 * The question in the conversation's last turn, when the agent ended its turn on one: the last loaded item
 * is an assistant message and it is the conversation's last item.
 */
export function lastAssistantText(l: Pick<Loaded, "items" | "total">): string | null {
  const last = l.items[l.items.length - 1];
  return last && last.kind === "assistant" && last.index === l.total - 1 ? last.text : null;
}
