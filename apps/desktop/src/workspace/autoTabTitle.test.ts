import { beforeEach, expect, it, vi } from "vitest";
import type { AgentsSettings, Api, SessionRow } from "@/api";
import { AGENTS_SETTINGS_DEFAULTS } from "@/mockSettings";
import { startAutoTabTitle, tabTitleFromPrompt } from "./autoTabTitle";
import type { Sessions, Tab } from "./sessions";

const PATH = "/demo/wt/xdev-oak";

it("tabTitleFromPrompt: first line, folded spaces, at most six words and forty characters", () => {
  expect(tabTitleFromPrompt("  fix   the\tfooter\nsecond line ignored")).toBe("fix the footer");
  expect(tabTitleFromPrompt("\n\n  first real line \nnext")).toBe("first real line");
  expect(tabTitleFromPrompt("one two three four five six")).toBe("one two three four five six");
  expect(tabTitleFromPrompt("one two three four five six seven")).toBe("one two three four five six…");
  const long = tabTitleFromPrompt("refactoring internationalization infrastructure considerations everywhere");
  expect(long).not.toBeNull();
  expect(long!.length).toBeLessThanOrEqual(40);
  expect(long!.endsWith("…")).toBe(true);
  expect(tabTitleFromPrompt("x".repeat(20) + " " + "y".repeat(20) + " " + "z".repeat(20))!.length).toBe(40);
  expect(tabTitleFromPrompt("")).toBeNull();
  expect(tabTitleFromPrompt(" \n \t ")).toBeNull();
  expect(tabTitleFromPrompt(null)).toBeNull();
});

it("tabTitleFromPrompt: cuts by code points, drops control and bidi marks, masks token-like words", () => {
  const a = "a".repeat(19) + " ";
  expect(tabTitleFromPrompt(a + "b".repeat(19) + "😀😀")).toBe(a + "b".repeat(19) + "…");
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  expect(lone.test(tabTitleFromPrompt(a + "b".repeat(18) + "😀😀😀")!)).toBe(false);
  expect(tabTitleFromPrompt("fix ‮txt.exe\u0007 now")).toBe("fix txt.exe now");
  expect(tabTitleFromPrompt(`use sk_${"live"}_${"abcdefghijklmnopqrstuvwxyz0123"} here`)).toBe("use … here");
});

it("tabTitleFromPrompt: names, branches and file names stay; keys and shas are masked", () => {
  expect(tabTitleFromPrompt("fix handleWorktreeTabsContextMenu")).toBe("fix handleWorktreeTabsContextMenu");
  expect(tabTitleFromPrompt("on feat-keep-awake-polling-off-main")).toBe("on feat-keep-awake-polling-off-main");
  expect(tabTitleFromPrompt("open sessions_snapshot_restore_test.ts")).toBe("open sessions_snapshot_restore_test.ts");
  expect(tabTitleFromPrompt(`token ghp_${"aB3".repeat(12)} leaked`)).toBe("token … leaked");
  expect(tabTitleFromPrompt("revert 0123456789abcdef0123456789abcdef01234567")).toBe("revert …");
});

function tab(over: Partial<Tab> = {}): Tab {
  return { id: "t1", worktree: PATH, profileId: "claude", account: null, accountSource: null, permissions: "ask", agent: true, status: "working", cli: "claude", unread: false, unreadAt: null, unreadReason: null, title: null, renamed: false, autoTitled: false, resumeOf: null, forkOf: null, agentSession: "abc", openedAt: 0, pinned: false, color: "none", client: {} as never, ...over };
}

function setup(opts: { on?: boolean; titles?: (string | null)[] } = {}) {
  let tabs: Tab[] = [tab()];
  const listeners = new Set<() => void>();
  const setAutoTitle = vi.fn();
  const sessions = {
    worktrees: () => [...new Set(tabs.map((t) => t.worktree))],
    tabs: (path: string) => tabs.filter((t) => t.worktree === path),
    tab: (id: string) => tabs.find((t) => t.id === id) ?? null,
    subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
    setAutoTitle,
  } as unknown as Sessions;
  const replies = [...(opts.titles ?? ["fix the footer usage meter rounding now"])];
  const agentSessions = vi.fn(async (): Promise<SessionRow[]> => {
    const title = replies.length > 1 ? replies.shift()! : replies[0]!;
    return [{ session: { key: "h:abc", id: "abc", homeId: "h", agent: "claude", cwd: PATH, branch: null, title, model: null, first: 1, last: 2, messages: 1 }, worktree: PATH, repo: null, resumable: true }];
  });
  let on = opts.on ?? true;
  const api = {
    agentsSettings: vi.fn(async (): Promise<AgentsSettings> => ({ ...AGENTS_SETTINGS_DEFAULTS, autoTabTitle: on })),
    agentSessions,
  } as unknown as Api;
  const emit = () => {
    for (const l of [...listeners]) l();
  };
  return {
    api,
    sessions,
    setAutoTitle,
    agentSessions,
    emit,
    set: (over: Partial<Tab>) => {
      tabs = tabs.map((t) => ({ ...t, ...over }));
      emit();
    },
    setting: (v: boolean) => {
      on = v;
    },
    listeners,
  };
}
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => vi.restoreAllMocks());

it("titles a working agent tab from its first prompt, once", async () => {
  const s = setup();
  startAutoTabTitle({ api: s.api, sessions: s.sessions });
  s.emit();
  await tick();
  expect(s.agentSessions).toHaveBeenCalledWith(expect.objectContaining({ text: "abc", scope: { kind: "worktree", path: PATH }, limit: 1 }), true);
  expect(s.setAutoTitle).toHaveBeenCalledExactlyOnceWith("t1", "fix the footer usage meter rounding…");
  s.emit();
  s.emit();
  await tick();
  expect(s.agentSessions).toHaveBeenCalledTimes(1);
});

it("does nothing while the setting is off, and reads it fresh for each tab", async () => {
  const s = setup({ on: false });
  startAutoTabTitle({ api: s.api, sessions: s.sessions });
  s.emit();
  await tick();
  expect(s.agentSessions).not.toHaveBeenCalled();
  expect(s.setAutoTitle).not.toHaveBeenCalled();
  s.setting(true);
  s.set({ id: "t2", agentSession: "abc" });
  await tick();
  expect(s.setAutoTitle).toHaveBeenCalledWith("t2", expect.any(String));
});

it("leaves alone a tab named by hand, titled already, not an agent, or without a session id", async () => {
  for (const over of [{ renamed: true }, { autoTitled: true }, { agent: false }, { agentSession: null }, { status: "idle" as const }]) {
    const s = setup();
    startAutoTabTitle({ api: s.api, sessions: s.sessions });
    s.set(over);
    await tick();
    expect(s.setAutoTitle).not.toHaveBeenCalled();
  }
});

it("a prompt the index has not read yet is tried again, three times at most", async () => {
  const s = setup({ titles: [null] });
  startAutoTabTitle({ api: s.api, sessions: s.sessions });
  for (let i = 0; i < 6; i++) {
    s.emit();
    await tick();
  }
  expect(s.agentSessions).toHaveBeenCalledTimes(3);
  expect(s.setAutoTitle).not.toHaveBeenCalled();
});

it("a retry that finds the prompt titles the tab", async () => {
  const s = setup({ titles: [null, "write the docs"] });
  startAutoTabTitle({ api: s.api, sessions: s.sessions });
  s.emit();
  await tick();
  s.emit();
  await tick();
  expect(s.setAutoTitle).toHaveBeenCalledExactlyOnceWith("t1", "write the docs");
});

it("a tab named by hand while the lookup runs keeps its name", async () => {
  const s = setup();
  startAutoTabTitle({ api: s.api, sessions: s.sessions });
  s.emit();
  s.set({ renamed: true });
  await tick();
  expect(s.setAutoTitle).not.toHaveBeenCalled();
});

it("a failing lookup is silent, and stop ends the watching", async () => {
  const s = setup();
  s.agentSessions.mockRejectedValue({ code: "io" });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const stop = startAutoTabTitle({ api: s.api, sessions: s.sessions });
  s.emit();
  await tick();
  expect(s.setAutoTitle).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledTimes(1);
  stop();
  expect(s.listeners.size).toBe(0);
});
