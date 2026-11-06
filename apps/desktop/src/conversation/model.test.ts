import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEntry } from "@/api";
import { createMockConversation, fixtureConversation, fixtureSubagentConversation } from "./mockConversation";
import { atBottom, DEFAULT_PREFS, failedSteps, firstIndex, foldRows, followUpText, hasOlder, lastAssistantText, mergePage, olderPage, readPrefs, runOf, stepSize, writePrefs, type Loaded } from "./model";
import { conversationItems, canShowConversation, closeConversation, isConversationOpen, openConversation } from "./conversationStore";

const NOW = Date.parse("2026-11-05T12:00:00Z");

function entry(index: number, kind: string, over: Partial<ConversationEntry> = {}): ConversationEntry {
  return { index, kind, text: kind === "tool" ? "" : `text ${index}`, at: 0, tool: kind === "tool" ? { name: "Bash", summary: "ls", status: "ok", output: "", cut: false } : null, marker: kind === "marker" ? "compact" : null, ...over };
}

it("folds each run of tool steps into one row and keeps the rest in order", () => {
  const rows = foldRows([entry(0, "user"), entry(1, "assistant"), entry(2, "tool"), entry(3, "tool"), entry(4, "tool"), entry(5, "assistant"), entry(6, "tool"), entry(7, "marker"), entry(8, "tool")]);
  expect(rows.map((r) => r.kind)).toEqual(["user", "assistant", "tools", "assistant", "tools", "marker", "tools"]);
  const first = rows[2]!;
  expect(first.kind === "tools" && first.items.map((i) => i.index)).toEqual([2, 3, 4]);
  // Keys are stable across pages: they come from the item index.
  expect(rows.map((r) => r.key)).toEqual(["i0", "i1", "t2", "i5", "t6", "m7", "t8"]);
});

it("skips a kind it does not know without splitting a run", () => {
  const rows = foldRows([entry(0, "tool"), entry(1, "question"), entry(2, "tool"), entry(3, "user")]);
  expect(rows.map((r) => r.kind)).toEqual(["tools", "user"]);
  expect(rows[0]!.kind === "tools" && rows[0]!.items).toHaveLength(2);
});

it("counts the failed steps of a run", () => {
  const items = [entry(0, "tool"), entry(1, "tool", { tool: { name: "Bash", summary: "x", status: "error", output: "no", cut: false } })];
  expect(failedSteps(items)).toBe(1);
});

it("pages through the mock from the end back to the start without gaps or repeats", async () => {
  const api = createMockConversation(() => NOW);
  const all = Array.from({ length: 23 }, (_, i) => entry(i, i % 3 === 0 ? "user" : "tool"));
  api.__conversation(all);
  let loaded: Loaded = mergePage(null, await api.agentConversation("s1", undefined, 10));
  expect(loaded.items.map((i) => i.index)).toEqual([13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
  expect(loaded.total).toBe(23);
  expect(hasOlder(loaded)).toBe(true);
  expect(olderPage(loaded, 10)).toEqual({ from: 3, limit: 10 });
  loaded = mergePage(loaded, await api.agentConversation("s1", 3, 10));
  expect(olderPage(loaded, 10)).toEqual({ from: 0, limit: 3 });
  loaded = mergePage(loaded, await api.agentConversation("s1", 0, 3));
  expect(loaded.items.map((i) => i.index)).toEqual(all.map((i) => i.index));
  expect(hasOlder(loaded)).toBe(false);
  expect(loaded.turns).toBe(8);
});

it("a refresh replaces items it holds again and adds new ones; a gap starts over", () => {
  const facts = { key: "k", agent: "claude", model: "m", turns: 1, markers: [], subagents: [] };
  const base = mergePage(null, { ...facts, from: 0, total: 3, items: [entry(0, "user"), entry(1, "tool", { tool: { name: "Bash", summary: "x", status: "pending", output: "", cut: false } }), entry(2, "assistant")] });
  const ended = entry(1, "tool", { tool: { name: "Bash", summary: "x", status: "ok", output: "done", cut: false } });
  const next = mergePage(base, { ...facts, from: 1, total: 4, items: [ended, entry(2, "assistant"), entry(3, "user")] });
  expect(next.items.map((i) => i.index)).toEqual([0, 1, 2, 3]);
  expect(next.items[1]!.tool?.status).toBe("ok");
  expect(next.total).toBe(4);
  const far = mergePage(next, { ...facts, from: 500, total: 700, items: [entry(500, "user"), entry(501, "assistant")] });
  expect(far.items.map((i) => i.index)).toEqual([500, 501]);
  expect(firstIndex(far)).toBe(500);
  // An empty session.
  const empty = mergePage(null, { ...facts, from: 0, total: 0, items: [] });
  expect(hasOlder(empty)).toBe(false);
});

it("the mock rejects an unknown session and holds the limit to its range", async () => {
  const api = createMockConversation(() => NOW);
  await expect(api.agentConversation("missing")).rejects.toMatchObject({ code: "not_found" });
  const page = await api.agentConversation("s1", 0, 0);
  expect(page.items).toHaveLength(1);
  const past = await api.agentConversation("s1", 99);
  expect(past.items).toHaveLength(0);
  expect(past.total).toBe(fixtureConversation(NOW).length);
});

it("the fixture has tool steps, an error, a marker and file paths", () => {
  const items = fixtureConversation(NOW);
  expect(items.some((i) => i.tool?.status === "error")).toBe(true);
  expect(items.some((i) => i.marker === "compact")).toBe(true);
  expect(items.some((i) => i.text.includes("src/lib/format.ts"))).toBe(true);
});

it("the text size moves one step at a time and stops at the ends", () => {
  expect(stepSize("medium", 1)).toBe("large");
  expect(stepSize("large", 1)).toBe("large");
  expect(stepSize("medium", -1)).toBe("small");
  expect(stepSize("small", -1)).toBe("small");
});

it("knows when the list is at its end", () => {
  expect(atBottom({ scrollTop: 480, scrollHeight: 1000, clientHeight: 500 })).toBe(true);
  expect(atBottom({ scrollTop: 100, scrollHeight: 1000, clientHeight: 500 })).toBe(false);
});

describe("prefs", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    Object.assign(globalThis, {
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
    });
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("keeps the view and the text size, and falls back on bad data", () => {
    expect(readPrefs()).toEqual(DEFAULT_PREFS);
    writePrefs({ mode: "reader", size: "large" });
    expect(readPrefs()).toEqual({ mode: "reader", size: "large" });
    store.set("xdev.conversation.v1", JSON.stringify({ mode: "other", size: "huge" }));
    expect(readPrefs()).toEqual(DEFAULT_PREFS);
    store.set("xdev.conversation.v1", "{not json");
    expect(readPrefs()).toEqual(DEFAULT_PREFS);
  });
});

it("opens and closes per tab, and offers the palette item only for an agent tab with a session", () => {
  const t = (key: string) => key;
  expect(canShowConversation({ agent: true, agentSession: "s" })).toBe(true);
  expect(canShowConversation({ agent: true, agentSession: null })).toBe(false);
  expect(canShowConversation({ agent: false, agentSession: "s" })).toBe(false);
  expect(conversationItems(t, { id: "a", agent: false, agentSession: "s" })).toEqual([]);
  expect(conversationItems(t, null)).toEqual([]);
  const [item] = conversationItems(t, { id: "tab-1", agent: true, agentSession: "s" });
  expect(item).toMatchObject({ id: "conversation:open", kind: "action", title: "conversation.palette.open" });
  item!.run();
  expect(isConversationOpen("tab-1")).toBe(true);
  closeConversation("tab-1");
  expect(isConversationOpen("tab-1")).toBe(false);
  openConversation("tab-2");
  expect(isConversationOpen("tab-1")).toBe(false);
  closeConversation("tab-2");
});

describe("sub-agents and the last question", () => {
  it("gives each call that started a sub-agent a row of its own", () => {
    const { items } = fixtureSubagentConversation(0);
    const rows = foldRows(items);
    expect(rows.map((r) => r.kind)).toEqual(["user", "assistant", "subagent", "subagent", "assistant"]);
    // A plain step after a call starts a new run of steps.
    const mixed = foldRows([...items.slice(0, 3), { index: 5, kind: "tool", text: "", at: 0, tool: items[2]!.tool, marker: null }]);
    expect(mixed.map((r) => r.kind)).toEqual(["user", "assistant", "subagent", "tools"]);
  });

  it("finds a row's run and keeps the runs across pages", () => {
    const { items, subagents } = fixtureSubagentConversation(0);
    const page = { key: "k", agent: "claude", model: "m", turns: 1, markers: [], from: 0, total: items.length, items, subagents };
    const loaded = mergePage(null, page);
    expect(loaded.subagents).toHaveLength(2);
    expect(runOf(loaded, items[3]!)?.description).toBe("Check the docs");
    expect(runOf(loaded, items[1]!)).toBeNull();
    expect(runOf({ subagents: [] }, items[2]!)).toBeNull();
  });

  it("writes a follow-up that names the run and a short result", () => {
    const run = { description: "Find bugs", result: "a\n\nb   c" + "x".repeat(400) };
    const text = followUpText(run, (v) => `About ${v.description}: ${v.result}`, 20);
    expect(text).toBe(`About Find bugs: a b c${"x".repeat(14)}…`);
  });

  it("reads the last turn only when the agent spoke last", () => {
    const { items } = fixtureSubagentConversation(0);
    expect(lastAssistantText({ items, total: items.length })).toContain("Which fix should I make first?");
    // More items follow the loaded ones.
    expect(lastAssistantText({ items, total: items.length + 1 })).toBeNull();
    expect(lastAssistantText({ items: items.slice(0, 1), total: 1 })).toBeNull();
    expect(lastAssistantText({ items: [], total: 0 })).toBeNull();
  });
});
