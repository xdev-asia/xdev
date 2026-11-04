import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { RepoView, Task, WorktreeView } from "@/api";
import { translate } from "@/i18n";
import type { Sessions, Tab } from "@/workspace/sessions";
import { JumpPalette } from "./JumpPalette";
import { registerTerminal } from "@/terminal/terminalRegistry";
import type { TerminalHandle } from "@/terminal/Terminal";
import { PaletteHost, type PaletteActions, type PaletteHostProps } from "./PaletteHost";
import { NO_DETAILS } from "@/workspace/worktreeDetails";

const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0, effects: [] as (() => void)[], deps: [] as (unknown[] | undefined)[] }));
const store = vi.hoisted(() => ({ view: null as unknown }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const state = (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value; }];
  };
  return {
    ...react,
    useState: (initial: any) => (hooks.active ? state(initial) : react.useState(initial)),
    useSyncExternalStore: (_sub: unknown, snapshot: () => unknown) => snapshot(),
    useRef: (initial: unknown) => (hooks.active ? state(() => ({ current: initial }))[0] : react.useRef(initial)),
    useEffect: (effect: any, deps?: unknown[]) => (hooks.active ? void (hooks.effects.push(effect), hooks.deps.push(deps)) : void 0),
  };
});
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));
vi.mock("@/agents/profileStore", async (original) => ({ ...await original<typeof import("@/agents/profileStore")>(), useProfiles: () => store }));

type Node = ReactElement<Record<string, any>>;

const oak: WorktreeView = { path: "/wt/oak", name: "oak", branch: "feat/oak", head: null, start: null, primary: false, pinned: false, detached: false, ...NO_DETAILS };
const elm: WorktreeView = { ...oak, path: "/wt/elm", name: "elm", branch: "feat/elm" };
const repos: RepoView[] = [{ id: "x", shortName: "xdev", path: "/r/x", baseRef: "origin/main", worktreeRoot: "/wt", setupPolicy: "ask", scriptSource: "auto", localSetup: "", localArchive: "", docsDir: "docs", color: null, icon: null, ghAccount: null, localIssueCommand: "", missing: false, worktrees: [oak, elm], found: [] }];
const tabOf = (id: string, worktree: string, profileId: string, agent: boolean): Tab => ({ id, worktree, profileId, account: null, permissions: "ask", agent, status: "idle" } as Tab);

beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.deps = []; hooks.active = false;
  store.view = { defaultAgent: "codex", profiles: [], shells: [{ id: "shell-pwsh", name: "PowerShell" }] };
});

function host(over: Partial<PaletteHostProps> = {}) {
  const actions: PaletteActions = { selectWorktree: vi.fn(), frontTab: vi.fn(), showWorkspace: vi.fn(), openSettings: vi.fn(), newWorktree: vi.fn(), addRepo: vi.fn(), searchDocs: vi.fn(), toggleSidebar: vi.fn(), showDocs: vi.fn() };
  const open = vi.fn((worktree: string, profile: string) => tabOf("new1", worktree, profile, true));
  const tabs: Record<string, Tab[]> = { "/wt/oak": [tabOf("p1", "/wt/oak", "claude", true)], "/wt/elm": [tabOf("p2", "/wt/elm", "shell", false)] };
  const sessions = { tabs: (p: string) => tabs[p] ?? [], dot: () => null, lastActivity: () => null, open, setPinned: vi.fn(), moveToSplit: vi.fn(), canMoveToSplit: () => true } as unknown as Sessions;
  const props: PaletteHostProps = { open: true, onClose: vi.fn(), repos, sessions, current: oak, shownTab: "p1", actions, ...over };
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return PaletteHost(props) as Node; } finally { hooks.active = false; }
  };
  const palette = () => draw().props as { items: { id: string; title: string; status?: string; worktree?: string; run(): void }[] };
  const item = (id: string) => palette().items.find((i) => i.id === id)!;
  return { actions, open, props, draw, palette, item, sessions: sessions as unknown as Record<string, ReturnType<typeof vi.fn>> };
}

it("lists Stage all and Discard all for the selected worktree and runs them", () => {
  const stageAllChanges = vi.fn();
  const discardAllChanges = vi.fn();
  const h = host();
  h.props.actions.stageAllChanges = stageAllChanges;
  h.props.actions.discardAllChanges = discardAllChanges;
  expect(h.item("act:stageAll").title).toBe(translate("en", "palette.action.stageAll"));
  h.item("act:stageAll").run();
  h.item("act:discardAll").run();
  expect(stageAllChanges).toHaveBeenCalled();
  expect(discardAllChanges).toHaveBeenCalled();
  // Without a selected worktree there is nothing to act on.
  const none = host({ current: null });
  none.props.actions.stageAllChanges = stageAllChanges;
  expect(none.palette().items.some((i) => i.id === "act:stageAll")).toBe(false);
});

it("builds tab, worktree, setting and action items", () => {
  const h = host();
  expect(h.draw().type).toBe(JumpPalette);
  const ids = h.palette().items.map((i) => i.id);
  expect(ids).toEqual(expect.arrayContaining(["tab:p1", "tab:p2", "wt:/wt/oak", "wt:/wt/elm", "set:agents", "act:newWorktree", "act:addRepo"]));
});

it("picking a tab selects its worktree and fronts it", () => {
  const h = host();
  h.item("tab:p2").run();
  expect(h.actions.selectWorktree).toHaveBeenCalledWith(elm);
  expect(h.actions.frontTab).toHaveBeenCalledWith("/wt/elm", "p2");
});

it("new agent tab opens the default agent in the current worktree", () => {
  const h = host();
  h.item("act:newAgentTab").run();
  expect(h.open).toHaveBeenCalledWith("/wt/oak", "codex");
  expect(h.actions.frontTab).toHaveBeenCalledWith("/wt/oak", "new1");
  h.item("act:newShellTab").run();
  expect(h.open).toHaveBeenLastCalledWith("/wt/oak", "shell-pwsh");
});

it("new tabs show the workspace first, then front the tab", () => {
  const h = host();
  const order: string[] = [];
  vi.mocked(h.actions.showWorkspace).mockImplementation(() => void order.push("show"));
  h.open.mockImplementation((worktree: string, profile: string) => { order.push("open"); return tabOf("new1", worktree, profile, true); });
  vi.mocked(h.actions.frontTab).mockImplementation(() => void order.push("front"));
  h.item("act:newAgentTab").run();
  expect(order).toEqual(["show", "open", "front"]);
  h.item("act:newShellTab").run();
  expect(h.actions.showWorkspace).toHaveBeenCalledTimes(2);
});

it("no current worktree hides the tab actions", () => {
  const h = host({ current: null, shownTab: null });
  const ids = h.palette().items.map((i) => i.id);
  expect(ids).not.toContain("act:newAgentTab");
  expect(ids).not.toContain("act:newShellTab");
  expect(ids).toContain("act:addRepo");
});

it("notes the current worktree and shown tab as recent", () => {
  const h = host();
  h.draw();
  hooks.effects.splice(0).forEach((e) => e());
  const recent = h.palette() as unknown as { recent: { at(id: string): number | null } };
  expect(recent.recent.at("wt:/wt/oak")).not.toBeNull();
  expect(recent.recent.at("tab:p1")).not.toBeNull();
  expect(recent.recent.at("wt:/wt/elm")).toBeNull();
});

it("search docs action calls openSearch", () => {
  const h = host();
  h.item("act:searchDocs").run();
  expect(h.actions.searchDocs).toHaveBeenCalled();
});

it("attention reaches the tab items", () => {
  const h = host({ attention: (id) => (id === "p2" ? "needs-you" : null) });
  expect(h.item("tab:p2").status).toBe("needs-you");
  expect(h.item("tab:p1").status).toBe("idle");
});

it("opens settings on the section and builds nothing while closed", () => {
  const h = host();
  h.item("set:repos").run();
  expect(h.actions.openSettings).toHaveBeenCalledWith("repos");
  expect(host({ open: false }).palette().items).toEqual([]);
});

const chatRow = (key: string, id: string, worktree: string, title: string, last: number) =>
  ({ session: { key, id, agent: "claude", branch: "main", title, last }, worktree, repo: "/r/x", resumable: true });

it("lists past chats of every worktree and an action that opens the panel", () => {
  const rowOak = chatRow("k1", "s1", "/wt/oak", "Fix login", 5);
  const rowElm = chatRow("k2", "s2", "/wt/elm", "Add search", 9);
  const history = { state: { rows: [rowOak, rowElm] }, subscribe: () => () => {}, refresh: vi.fn(async () => {}) };
  const h = host({ history: history as never });
  const resumeSession = vi.fn();
  const openSessions = vi.fn();
  h.props.actions.resumeSession = resumeSession;
  h.props.actions.openSessions = openSessions;
  expect(h.item("chat:k1").title).toBe("Fix login");
  expect(h.item("chat:k2").worktree).toBe("/wt/elm");
  h.item("chat:k2").run();
  expect(resumeSession).toHaveBeenCalledWith(rowElm);
  h.item("act:resumeSession").run();
  expect(openSessions).toHaveBeenCalled();
  hooks.effects.forEach((e) => e());
  expect(history.refresh).toHaveBeenCalled();
});

it("leaves out a past chat that a live tab already shows", () => {
  const live = chatRow("k1", "s1", "/wt/oak", "Fix login", 5);
  const history = { state: { rows: [live, chatRow("k2", "s2", "/wt/oak", "Other", 4)] }, subscribe: () => () => {}, refresh: vi.fn(async () => {}) };
  const h = host({ history: history as never });
  h.props.actions.resumeSession = vi.fn();
  (h.sessions as unknown as { tabs: (p: string) => Tab[] }).tabs = (p) => (p === "/wt/oak" ? [{ ...tabOf("p1", p, "claude", true), agentSession: "s1" } as Tab] : []);
  const ids = h.palette().items.map((i) => i.id);
  expect(ids).not.toContain("chat:k1");
  expect(ids).toContain("chat:k2");
});

const taskOf = (id: string, goal: string): Task => ({ id, goal, repo: "/r/x", base: "abc", branch: `task/${id}`, worktree: `/w/${id}`, state: "running", runs: [], evidence: null, approval: null, created: 100 });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

it("reads the tasks when the palette opens and opens one on pick", async () => {
  const tasks = vi.fn(async () => [taskOf("t1", "Add login")]);
  const h = host({ tasks });
  const openTask = vi.fn();
  h.props.actions.openTask = openTask;
  h.draw();
  hooks.effects.forEach((e) => e());
  await settle();
  expect(tasks).toHaveBeenCalledTimes(1);
  expect(h.item("task:t1").title).toBe("Add login");
  h.item("task:t1").run();
  expect(openTask).toHaveBeenCalledWith("t1");
});

it("a new tasks reader on each render does not read the tasks again", async () => {
  const h = host({ tasks: async () => [] });
  h.props.actions.openTask = vi.fn();
  h.draw();
  const first = hooks.deps.slice();
  hooks.deps = [];
  // The shell passes a fresh arrow on each render.
  const latest = vi.fn(async () => [taskOf("t2", "Fix bug")]);
  h.props.tasks = latest;
  h.draw();
  expect(hooks.deps.length).toBe(first.length);
  hooks.deps.forEach((d, i) => expect(d?.every((v, j) => Object.is(v, first[i]?.[j]))).toBe(true));
  // An opening still reads through the newest reader.
  hooks.effects = [];
  h.draw();
  hooks.effects.forEach((e) => e());
  await settle();
  expect(latest).toHaveBeenCalledTimes(1);
});

it("a rejected tasks() still renders the other items", async () => {
  const tasks = vi.fn(async () => { throw new Error("no vault"); });
  const h = host({ tasks });
  h.props.actions.openTask = vi.fn();
  h.draw();
  hooks.effects.forEach((e) => e());
  await settle();
  const ids = h.palette().items.map((i) => i.id);
  expect(ids.some((i) => i.startsWith("task:"))).toBe(false);
  expect(ids).toContain("wt:/wt/oak");
});

it("offers the repos that are not missing as project scopes", () => {
  const h = host();
  expect((h.draw().props as { scopes: unknown }).scopes).toEqual([{ path: "/r/x", name: "xdev" }]);
});

it("lists the focused tab's actions and runs them through Sessions and the terminal handle", async () => {
  const calls: string[] = [];
  const handle = {
    clear: () => calls.push("clear"),
    reset: () => calls.push("reset"),
    lines: () => ["$ ls"],
  } as unknown as TerminalHandle;
  registerTerminal("p1", handle);
  const writeText = vi.fn(async (_text: string) => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  try {
    const h = host();
    const ids = h.palette().items.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining(["act:pinTab", "act:moveTabRight", "act:clearTerminal", "act:resetTerminal", "act:copyTerminalContext"]));
    expect(ids).not.toContain("act:unpinTab");
    h.item("act:pinTab").run();
    h.item("act:moveTabRight").run();
    h.item("act:clearTerminal").run();
    h.item("act:resetTerminal").run();
    h.item("act:copyTerminalContext").run();
    await Promise.resolve();
    expect(h.sessions.setPinned).toHaveBeenCalledWith("p1", true);
    expect(h.sessions.moveToSplit).toHaveBeenCalledWith("p1", "right");
    expect(calls).toEqual(["clear", "reset"]);
    expect(writeText.mock.calls[0][0]).toContain("$ ls");
    // No terminal registered for the tab in front: the terminal actions are not listed.
    registerTerminal("p1", null);
    expect(h.palette().items.some((i) => i.id === "act:clearTerminal")).toBe(false);
    // Nothing in front (a file tab): no tab actions at all.
    expect(host({ shownTab: "file:a.md" }).palette().items.some((i) => i.id === "act:pinTab")).toBe(false);
  } finally {
    registerTerminal("p1", null);
    vi.unstubAllGlobals();
  }
});

it("opens settings on the section and entry for a setting entry", () => {
  const h = host();
  h.item("set:git.prefix").run();
  expect(h.actions.openSettings).toHaveBeenCalledWith("git", "git.prefix");
});
