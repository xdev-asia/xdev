import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMockApi, type Api, type GitSettings, type WorktreeView } from "@/api";
import { DEFAULT_GIT_SETTINGS, DEMO_WORKSPACE } from "@/mockWorkspace";
import { NO_DETAILS } from "./worktreeDetails";
import { shouldRename, startAutoRename, type AutoRenameDeps } from "./autoRename";
import type { Sessions, Tab } from "./sessions";

const PATH = "/demo/wt/xdev-oak";

function wt(over: Partial<WorktreeView> = {}): WorktreeView {
  return { path: PATH, name: "oak", branch: "oak", head: null, start: "s", primary: false, pinned: false, detached: false, ...NO_DETAILS, autoName: true, ...over };
}
function tab(over: Partial<Tab> = {}): Tab {
  return { id: "t1", worktree: PATH, profileId: "claude", account: null, accountSource: null, permissions: "ask", agent: true, status: "idle", cli: "claude", unread: false, unreadAt: null, unreadReason: null, title: null, renamed: false, resumeOf: null, agentSession: null, openedAt: 0, pinned: false, color: "none", client: {} as never, ...over };
}

const git = (over: Partial<GitSettings> = {}): GitSettings => ({ ...DEFAULT_GIT_SETTINGS, ...over });

it("shouldRename: only an auto-named, branched, not yet tried worktree, with the setting on", () => {
  expect(shouldRename(wt(), git(), new Set())).toBe(true);
  expect(shouldRename(wt({ autoName: false }), git(), new Set())).toBe(false);
  expect(shouldRename(wt(), git({ autoRenameBranch: false }), new Set())).toBe(false);
  expect(shouldRename(wt(), git(), new Set([PATH]))).toBe(false);
  expect(shouldRename(wt({ detached: true, branch: null }), git(), new Set())).toBe(false);
  expect(shouldRename(wt({ primary: true }), git(), new Set())).toBe(false);
});

// What the watcher reads: the tab list and `subscribe`.
function fakeSessions() {
  let tabs: Tab[] = [tab()];
  const listeners = new Set<() => void>();
  const sessions = { tabs: (path: string) => tabs.filter((t) => t.worktree === path), subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)) };
  const set = (over: Partial<Tab>) => {
    tabs = tabs.map((t) => ({ ...t, ...over }));
    for (const l of [...listeners]) l();
  };
  return { sessions: sessions as unknown as Sessions, set };
}

type Toast = { text: string; actions?: { label: string; run(): void }[] };

function setup(opts: { git?: Partial<GitSettings>; remotes?: boolean; prompt?: string | null; worktrees?: WorktreeView[] } = {}) {
  const base = structuredClone(DEMO_WORKSPACE);
  const api: Api = createMockApi({}, {
    workspace: {
      ...base,
      git: { branchPrefix: "custom", branchPrefixCustom: "me", ...opts.git },
      prompts: opts.prompt === null ? {} : { [PATH]: opts.prompt ?? "fix the footer usage meter rounding" },
      remotes: opts.remotes ? { [PATH]: { ahead: 0, behind: 0 } } : undefined,
    },
  });
  const { sessions, set } = fakeSessions();
  const toasts: Toast[] = [];
  const reload = vi.fn();
  let current: WorktreeView[] = opts.worktrees ?? [wt()];
  const deps: AutoRenameDeps = {
    api,
    sessions,
    worktrees: () => current,
    t: (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
    reload: () => {
      reload();
    },
    toast: (toast) => toasts.push(toast),
  };
  const stop = startAutoRename(deps);
  const settle = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };
  return { api, set, toasts, reload, stop, settle, setWorktrees: (w: WorktreeView[]) => (current = w) };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

it("renames on the first prompt of an agent tab and says so with an Undo", async () => {
  const s = setup();
  const rename = vi.spyOn(s.api, "worktreeRenameBranch");
  s.set({ status: "working", agentSession: "sess-1" });
  await s.settle();
  expect(rename).toHaveBeenCalledWith(PATH, "fix-the-footer-usage");
  expect(s.reload).toHaveBeenCalled();
  expect(s.toasts).toHaveLength(1);
  expect(s.toasts[0].text).toContain("branchRename.toast");
  expect(s.toasts[0].text).toContain("fix-the-footer-usage");
  expect(s.toasts[0].actions![0].label).toBe("branchRename.undo");
});

it("keeps a name the user gave while the suggestion was running", async () => {
  for (const renamed of [wt({ autoName: false, branch: "mine" }), wt({ branch: "mine" })]) {
    const s = setup();
    const rename = vi.spyOn(s.api, "worktreeRenameBranch");
    let answer!: (name: string) => void;
    vi.spyOn(s.api, "worktreeSuggestBranch").mockImplementation(() => new Promise<string>((r) => (answer = r)));
    s.set({ status: "working", agentSession: "sess-1" });
    await s.settle();
    s.setWorktrees([renamed]);
    answer("fix-the-footer-usage");
    await s.settle();
    expect(rename).not.toHaveBeenCalled();
    expect(s.toasts).toEqual([]);
  }
});

it("asks for the suggestion of the tab's own session", async () => {
  const s = setup();
  const suggest = vi.spyOn(s.api, "worktreeSuggestBranch");
  s.set({ status: "working", agentSession: "sess-9" });
  await s.settle();
  expect(suggest).toHaveBeenCalledWith(PATH, "sess-9");
});

it("does nothing with the setting off, for a typed name, or while the tab has no session yet", async () => {
  for (const [over, worktrees] of [
    [{ git: { autoRenameBranch: false } }, undefined],
    [{}, [wt({ autoName: false })]],
  ] as const) {
    const s = setup({ ...over, worktrees: worktrees as WorktreeView[] | undefined });
    const rename = vi.spyOn(s.api, "worktreeRenameBranch");
    s.set({ status: "working", agentSession: "sess-1" });
    await s.settle();
    expect(rename).not.toHaveBeenCalled();
    expect(s.toasts).toEqual([]);
  }
  const s = setup();
  const rename = vi.spyOn(s.api, "worktreeRenameBranch");
  s.set({ status: "working", agentSession: null });
  await s.settle();
  expect(rename).not.toHaveBeenCalled();
});

it("ignores a tab that is not an agent, or is not working", async () => {
  const s = setup();
  const rename = vi.spyOn(s.api, "worktreeRenameBranch");
  s.set({ status: "working", agentSession: "sess-1", agent: false });
  s.set({ status: "idle", agent: true });
  await s.settle();
  expect(rename).not.toHaveBeenCalled();
});

it("tries a worktree once per run: a second prompt does nothing", async () => {
  const s = setup();
  const rename = vi.spyOn(s.api, "worktreeRenameBranch");
  s.set({ status: "working", agentSession: "sess-1" });
  await s.settle();
  // The list still says auto-named (it was not reloaded in this fake); a second prompt must not retry.
  s.set({ status: "idle" });
  s.set({ status: "working" });
  await s.settle();
  expect(rename).toHaveBeenCalledTimes(1);
});

it("does nothing for a pushed branch, silently", async () => {
  const s = setup({ remotes: true });
  s.set({ status: "working", agentSession: "sess-1" });
  await s.settle();
  expect(s.toasts).toEqual([]);
  expect(s.reload).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
});

it("a failure is silent and logged once", async () => {
  const s = setup();
  vi.spyOn(s.api, "worktreeRenameBranch").mockRejectedValue({ code: "io", message: "disk" });
  s.set({ status: "working", agentSession: "sess-1" });
  await s.settle();
  s.set({ status: "idle" });
  s.set({ status: "working" });
  await s.settle();
  expect(s.toasts).toEqual([]);
  expect(warn).toHaveBeenCalledTimes(1);
});

it("a prompt the index has not seen yet is tried again on the next prompt, a few times at most", async () => {
  const s = setup({ prompt: null });
  const suggest = vi.spyOn(s.api, "worktreeSuggestBranch");
  for (let i = 0; i < 5; i++) {
    s.set({ status: "idle", agentSession: "sess-1" });
    s.set({ status: "working" });
    await s.settle();
  }
  expect(suggest).toHaveBeenCalledTimes(3);
  expect(s.toasts).toEqual([]);
});

it("Undo renames back while still unpushed, clears the title, and says why when it cannot", async () => {
  const s = setup();
  const rename = vi.spyOn(s.api, "worktreeRenameBranch");
  const details = vi.spyOn(s.api, "worktreeDetails");
  s.set({ status: "working", agentSession: "sess-1" });
  await s.settle();
  s.toasts[0].actions![0].run();
  await s.settle();
  expect(rename).toHaveBeenLastCalledWith(PATH, "oak");
  expect(details).toHaveBeenCalledWith(PATH, { title: null });
  expect(s.reload).toHaveBeenCalledTimes(2);

  // After a push the rename back is refused, and the person is told.
  const t = setup();
  t.set({ status: "working", agentSession: "sess-1" });
  await t.settle();
  vi.spyOn(t.api, "worktreeRenameBranch").mockRejectedValue({ code: "branch_pushed", message: "pushed" });
  t.toasts[0].actions![0].run();
  await t.settle();
  expect(t.toasts[1].text).toBe("error.branch_pushed");
});

it("stops watching when stopped", async () => {
  const s = setup();
  const rename = vi.spyOn(s.api, "worktreeRenameBranch");
  s.stop();
  s.set({ status: "working", agentSession: "sess-1" });
  await s.settle();
  expect(rename).not.toHaveBeenCalled();
});
