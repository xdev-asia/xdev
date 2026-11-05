import { afterEach, expect, it, vi } from "vitest";
import type { QuickCommand } from "@/api";
import type { Sessions, Tab } from "@/workspace/sessions";
import { runQuickCommand, type RunContext } from "./run";

afterEach(() => vi.useRealTimers());

function tab(id: string, over: Partial<Tab> = {}): Tab {
  return { id, worktree: "/w", profileId: "shell", account: null, accountSource: null, permissions: "ask", agent: false, status: "idle", cli: null, unread: false, unreadAt: null, unreadReason: null, title: null, renamed: false, autoTitled: false, resumeOf: null, forkOf: null, extraArgs: null, agentSession: null, openedAt: 0, pinned: false, color: "none", client: { input: vi.fn(async () => {}) } as never, ...over };
}

function fake(initial: Tab[] = []) {
  let tabs = initial;
  const listeners = new Set<() => void>();
  const opened = tab("new", { profileId: "claude", agent: true, cli: "claude", status: "idle" });
  const sessions = {
    tabs: () => tabs,
    open: vi.fn(() => {
      tabs = [...tabs, opened];
      return opened;
    }),
    subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
  };
  const set = (status: Tab["status"]) => {
    tabs = tabs.map((t) => (t.id === "new" ? { ...t, status } : t));
    for (const l of [...listeners]) l();
  };
  return { sessions: sessions as unknown as Sessions, open: sessions.open, opened, set };
}

const terminal = (command: string, appendEnter = true): QuickCommand => ({ id: "qc-1", label: "x", scope: { type: "global" }, action: { type: "terminal", command, appendEnter } });
const agent = (prompt: string, profile = "claude"): QuickCommand => ({ id: "qc-2", label: "r", scope: { type: "global" }, action: { type: "agent", profile, prompt } });
const ctx = (sessions: Sessions, over: Partial<RunContext> = {}): RunContext => ({ sessions, worktree: "/w", tab: null, used: vi.fn(), ...over });

it("types the command and Enter into the tab", async () => {
  const shell = tab("s");
  const c = ctx(fake().sessions, { tab: shell });
  expect(await runQuickCommand(terminal("cargo test"), c)).toEqual({ ok: true, tab: shell });
  expect(shell.client.input).toHaveBeenCalledWith("cargo test\r");
  expect(c.used).toHaveBeenCalledWith("qc-1");
});

it("leaves the text on the prompt line without Enter, and a run can turn Enter off", async () => {
  const shell = tab("s");
  await runQuickCommand(terminal("ls", false), ctx(fake().sessions, { tab: shell }));
  expect(shell.client.input).toHaveBeenLastCalledWith("ls");
  await runQuickCommand(terminal("ls", true), ctx(fake().sessions, { tab: shell, appendEnter: false }));
  expect(shell.client.input).toHaveBeenLastCalledWith("ls");
});

it("sends a multi-line command line by line", async () => {
  const shell = tab("s");
  await runQuickCommand(terminal("a\nb"), ctx(fake().sessions, { tab: shell }));
  expect(shell.client.input).toHaveBeenCalledWith("a\rb\r");
  await runQuickCommand(terminal("a\r\nb", false), ctx(fake().sessions, { tab: shell }));
  expect(shell.client.input).toHaveBeenLastCalledWith("a\rb");
});

it("writes nothing without a live terminal", async () => {
  const c = ctx(fake().sessions);
  expect(await runQuickCommand(terminal("ls"), c)).toEqual({ ok: false, reason: "noTerminal" });
  const dead = tab("d", { exitCode: 1 });
  expect(await runQuickCommand(terminal("ls"), ctx(fake().sessions, { tab: dead }))).toEqual({ ok: false, reason: "noTerminal" });
  expect(dead.client.input).not.toHaveBeenCalled();
  expect(c.used).not.toHaveBeenCalled();
});

it("focuses the terminal after typing", async () => {
  const shell = tab("s");
  const focus = vi.fn();
  await runQuickCommand(terminal("ls"), ctx(fake().sessions, { tab: shell, focus }));
  expect(focus).toHaveBeenCalledWith(shell);
});

it("opens an agent tab with the profile and pastes the prompt once it is ready", async () => {
  vi.useFakeTimers();
  const f = fake();
  const c = ctx(f.sessions);
  const run = runQuickCommand(agent("Review the diff"), c);
  expect(f.open).toHaveBeenCalledWith("/w", "claude");
  f.set("working");
  f.set("idle");
  expect(await run).toEqual({ ok: true, tab: expect.objectContaining({ id: "new" }) });
  expect(f.opened.client.input).toHaveBeenCalledWith("\x1b[200~Review the diff\x1b[201~\r");
  expect(c.used).toHaveBeenCalledWith("qc-2");
});

it("gives up on an agent that never gets ready", async () => {
  vi.useFakeTimers();
  const f = fake();
  const c = ctx(f.sessions, { timeoutMs: 1000 });
  const run = runQuickCommand(agent("hi"), c);
  await vi.advanceTimersByTimeAsync(1001);
  expect(await run).toEqual({ ok: false, reason: "agentNotReady" });
  expect(f.opened.client.input).not.toHaveBeenCalled();
  expect(c.used).not.toHaveBeenCalled();
});

it("does not open a tab for a profile that is not one", async () => {
  const f = fake();
  const res = await runQuickCommand(agent("hi", "nope"), ctx(f.sessions, { profiles: ["claude", "codex"] }));
  expect(res).toEqual({ ok: false, reason: "unknownAgent" });
  expect(f.open).not.toHaveBeenCalled();
});

it("a file command runs only when its file is trusted", async () => {
  const shell = tab("s");
  const file = { label: "Tests", action: { type: "terminal" as const, command: "cargo test", appendEnter: true } };
  expect(await runQuickCommand(file, ctx(fake().sessions, { tab: shell }))).toEqual({ ok: false, reason: "untrusted" });
  expect(await runQuickCommand(file, ctx(fake().sessions, { tab: shell, trusted: false }))).toEqual({ ok: false, reason: "untrusted" });
  expect(shell.client.input).not.toHaveBeenCalled();
  const c = ctx(fake().sessions, { tab: shell, trusted: true });
  expect(await runQuickCommand(file, c)).toEqual({ ok: true, tab: shell });
  expect(shell.client.input).toHaveBeenCalledWith("cargo test\r");
  expect(c.used).not.toHaveBeenCalled();
});
