import { expect, it, vi } from "vitest";
import type { ProfilesView, SessionRow } from "@/api";
import { chatCapable, chatTabItems, lastSession, openAgentTab, openAsOf, resumeFailed, type After } from "./chatOpen";

const row = (id: string, over: Partial<SessionRow> = {}, title = `T ${id}`): SessionRow =>
  ({ session: { id, agent: "claude", homeId: "default", title, first: 1 }, worktree: null, repo: null, resumable: true, ...over }) as unknown as SessionRow;

const view = (profiles: { id: string; cli: "claude" | "codex" | null; openAs?: "chat" | "terminal"; enabled?: boolean }[]): ProfilesView =>
  ({ profiles: profiles.map((p) => ({ profile: { name: p.id, enabled: true, ...p }, permissions: null })) }) as unknown as ProfilesView;

const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${Object.values(vars).join(",")}` : key);

it("only claude and codex are chat-capable", () => {
  expect(chatCapable("claude")).toBe(true);
  expect(chatCapable("codex")).toBe(true);
  expect(chatCapable(null)).toBe(false);
  expect(chatCapable("shell")).toBe(false);
  expect(chatCapable("mine")).toBe(false);
});

it("openAsOf follows the profile only when it is chat-capable", () => {
  expect(openAsOf(view([{ id: "claude", cli: "claude", openAs: "chat" }]), "claude")).toBe("chat");
  expect(openAsOf(view([{ id: "claude", cli: "claude" }]), "claude")).toBe("terminal");
  expect(openAsOf(view([]), "nope")).toBe("terminal");
  expect(openAsOf(null, "claude")).toBe("terminal");
  expect(openAsOf(view([{ id: "mine", cli: null, openAs: "chat" }]), "mine")).toBe("terminal");
});

const sessionsWith = (tabs: { agentSession: string | null; resumeOf: string | null }[] = []) => ({ tabs: () => tabs }) as never;

it("lastSession skips live and non-resumable rows", async () => {
  const rows = [row("live"), row("gone", { resumable: false }), row("ok"), row("older")];
  const api = { agentSessions: vi.fn(async () => rows) };
  const got = await lastSession(api, sessionsWith([{ agentSession: "live", resumeOf: null }]), "/w", "claude");
  expect(got?.session.id).toBe("ok");
  expect(api.agentSessions).toHaveBeenCalledWith(expect.objectContaining({ scope: { kind: "worktree", path: "/w" }, agent: "claude", limit: 5 }), false);
});

it("lastSession gives null on a rejection and on a timeout", async () => {
  expect(await lastSession({ agentSessions: async () => Promise.reject(new Error("x")) }, sessionsWith(), "/w", "claude")).toBeNull();
  let fire = () => {};
  const after: After = (fn) => {
    fire = fn;
    return () => {};
  };
  const p = lastSession({ agentSessions: () => new Promise(() => {}) }, sessionsWith(), "/w", "codex", 2000, after);
  fire();
  expect(await p).toBeNull();
});

function fake(rows: SessionRow[]) {
  const tab = { id: "t1" };
  const sessions = {
    tabs: () => [],
    open: vi.fn(() => tab),
    resume: vi.fn(() => tab),
    setView: vi.fn(),
  };
  const api = { agentSessions: vi.fn(async () => rows) };
  return { sessions, api, deps: { api, sessions, profiles: null } as never };
}

it("openAgentTab as chat resumes a hit, then switches the view", async () => {
  const f = fake([row("s1", {}, "Fix it")]);
  await openAgentTab(f.deps, { worktree: "/w", profile: "claude", cli: "claude", view: "chat" });
  expect(f.sessions.resume).toHaveBeenCalledWith("/w", "claude", null, "s1", "Fix it", "claude");
  expect(f.sessions.open).not.toHaveBeenCalled();
  expect(f.sessions.setView).toHaveBeenCalledWith("t1", "chat");
});

it("openAgentTab as chat with no hit opens fresh", async () => {
  const f = fake([]);
  await openAgentTab(f.deps, { worktree: "/w", profile: "claude", cli: "claude", view: "chat" });
  expect(f.sessions.open).toHaveBeenCalled();
  expect(f.sessions.setView).toHaveBeenCalledWith("t1", "chat");
});

it("openAgentTab as terminal only opens, with no lookup", async () => {
  const f = fake([row("s1")]);
  await openAgentTab(f.deps, { worktree: "/w", profile: "claude", cli: "claude", view: "terminal" });
  expect(f.api.agentSessions).not.toHaveBeenCalled();
  expect(f.sessions.open).toHaveBeenCalled();
  expect(f.sessions.setView).not.toHaveBeenCalled();
});

it("resumeFailed needs a chat tab that resumed and exited inside the grace window", () => {
  const base = { view: "chat" as const, resumeOf: "s1", exitCode: 1, openedAt: 0 };
  expect(resumeFailed(base, 9_999)).toBe(true);
  expect(resumeFailed(base, 10_000)).toBe(false);
  expect(resumeFailed({ ...base, resumeOf: null }, 5)).toBe(false);
  expect(resumeFailed({ ...base, exitCode: undefined }, 5)).toBe(false);
  expect(resumeFailed({ ...base, view: undefined }, 5)).toBe(false);
});

it("chatTabItems lists toggle, open and open-as-terminal items", () => {
  const profiles = view([{ id: "claude", cli: "claude", openAs: "chat" }, { id: "codex", cli: "codex" }, { id: "mine", cli: null }]);
  const o = { profiles, name: (id: string) => id, open: vi.fn(), toggle: vi.fn() };
  const ids = (front: { id: string; agent: boolean; cli: "claude" | null } | null) => chatTabItems(t, { ...o, front }).map((i) => i.id);
  expect(ids({ id: "a", agent: true, cli: "claude" })).toEqual(["chat:open:claude", "chat:terminal:claude", "chat:open:codex", "chat:toggle"]);
  expect(ids({ id: "a", agent: false, cli: null })).not.toContain("chat:toggle");
});
