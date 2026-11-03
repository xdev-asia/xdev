import { afterEach, expect, it, vi } from "vitest";
import { pastePrompt, sendToAgentTab, sendToChosenTab } from "./agentPrompt";
import type { Sessions, Tab } from "./sessions";
import type { TabStatus } from "./status";

afterEach(() => vi.useRealTimers());

function tab(id: string, over: Partial<Tab> = {}): Tab {
  return { id, worktree: "/w", profileId: "claude", account: null, permissions: "ask", agent: true, status: "idle", cli: "claude", unread: false, unreadAt: null, unreadReason: null, title: null, renamed: false, client: { input: vi.fn(async () => {}) } as never, ...over };
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
  const dead = tab("d", { status: "exited", exitCode: 0 });
  const live = tab("l");
  const { sessions, open } = fake([shell, dead, live]);
  expect(await sendToAgentTab(sessions, "/w", "s", "hi")).toBe(live);
  expect(open).not.toHaveBeenCalled();
});

it("a failed turn still takes a prompt; a pty that exited does not", async () => {
  const turn = tab("t", { status: "failed" });
  const crashed = tab("c", { status: "failed", exitCode: 1 });
  const { sessions, open } = fake([crashed, turn]);
  expect(await sendToAgentTab(sessions, "/w", "t", "hi")).toBe(turn);
  expect(await sendToAgentTab(sessions, "/w", "c", "hi")).toBe(turn);
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

it("sendToChosenTab types into the chosen running tab and never opens one", async () => {
  const a = tab("a");
  const b = tab("b");
  const f = fake([a, b]);
  expect(await sendToChosenTab(f.sessions, "/w", { tab: "a" }, "hi")).toBe(a);
  expect(a.client.input).toHaveBeenCalledTimes(1);
  expect(b.client.input).not.toHaveBeenCalled();
  expect(f.open).not.toHaveBeenCalled();
});

it("sendToChosenTab gives up on a tab that ended, and waits for a new one", async () => {
  vi.useFakeTimers();
  const dead = tab("d", { status: "exited", exitCode: 0 });
  const f = fake([dead]);
  expect(await sendToChosenTab(f.sessions, "/w", { tab: "d" }, "hi")).toBeNull();
  expect(dead.client.input).not.toHaveBeenCalled();

  const result = sendToChosenTab(f.sessions, "/w", { profile: "codex" }, "hi");
  expect(f.open).toHaveBeenCalledWith("/w", "codex");
  f.set("working");
  f.set("idle");
  expect((await result)?.id).toBe("new");
});
