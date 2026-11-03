import { afterEach, expect, it, vi } from "vitest";
import { pastePrompt, sendToAgentTab } from "./agentPrompt";
import type { Sessions, Tab } from "./sessions";
import type { TabStatus } from "./status";

afterEach(() => vi.useRealTimers());

function tab(id: string, over: Partial<Tab> = {}): Tab {
  return { id, worktree: "/w", profileId: "claude", agent: true, status: "idle", client: { input: vi.fn(async () => {}) } as never, ...over };
}

// Just what sendToAgentTab reads: a tab list that can change and tell its listeners.
function fake(initial: Tab[]) {
  let tabs = initial;
  const listeners = new Set<() => void>();
  const opened = tab("new", { status: "idle" });
  const sessions = {
    tabs: () => tabs,
    open: vi.fn(() => {
      tabs = [...tabs, opened];
      return opened;
    }),
    subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
  };
  const set = (status: TabStatus) => {
    tabs = tabs.map((t) => (t.id === "new" ? { ...t, status } : t));
    for (const l of [...listeners]) l();
  };
  return { sessions: sessions as unknown as Sessions, open: sessions.open, opened, set };
}

it("wraps in bracketed paste and ends with Enter", () => {
  expect(pastePrompt("fix it")).toBe("\x1b[200~fix it\x1b[201~\r");
});

it("strips escape and control characters but keeps newlines and tabs", () => {
  expect(pastePrompt("a\x1b[31mb\tc\nd\r\ne\x00\x07\x7ff")).toBe("\x1b[200~a[31mb\tc\nd\nef\x1b[201~\r");
});

it("prefers the shown running agent tab", async () => {
  const a = tab("a");
  const b = tab("b");
  const { sessions, open } = fake([a, b]);
  expect(await sendToAgentTab(sessions, "/w", "b", "hi")).toBe(b);
  expect(b.client.input).toHaveBeenCalledWith("\x1b[200~hi\x1b[201~\r");
  expect(a.client.input).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});

it("falls back to another running agent tab", async () => {
  const shell = tab("s", { agent: false, profileId: "shell" });
  const dead = tab("d", { status: "exited" });
  const live = tab("l");
  const { sessions, open } = fake([shell, dead, live]);
  expect(await sendToAgentTab(sessions, "/w", "s", "hi")).toBe(live);
  expect(open).not.toHaveBeenCalled();
});

it("opens a claude tab and waits for idle", async () => {
  vi.useFakeTimers();
  const f = fake([tab("s", { agent: false, profileId: "shell" })]);
  const result = sendToAgentTab(f.sessions, "/w", null, "hi");
  expect(f.open).toHaveBeenCalledWith("/w", "claude");
  f.set("working");
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.opened.client.input).not.toHaveBeenCalled();
  f.set("idle");
  const used = await result;
  expect(used?.id).toBe("new");
  expect(f.opened.client.input).toHaveBeenCalledWith("\x1b[200~hi\x1b[201~\r");
});

it("returns null after the timeout", async () => {
  vi.useFakeTimers();
  const f = fake([]);
  const result = sendToAgentTab(f.sessions, "/w", null, "hi", { timeoutMs: 30_000 });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await result).toBeNull();
  expect(f.opened.client.input).not.toHaveBeenCalled();
});
