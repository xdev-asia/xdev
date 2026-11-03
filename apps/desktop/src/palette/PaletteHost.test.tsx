import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { RepoView, WorktreeView } from "@/api";
import { translate } from "@/i18n";
import type { Sessions, Tab } from "@/workspace/sessions";
import { JumpPalette } from "./JumpPalette";
import { PaletteHost, type PaletteActions, type PaletteHostProps } from "./PaletteHost";

const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
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
    useEffect: (effect: any) => (hooks.active ? void hooks.effects.push(effect) : void 0),
  };
});
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));
vi.mock("@/agents/profileStore", async (original) => ({ ...await original<typeof import("@/agents/profileStore")>(), useProfiles: () => store }));

type Node = ReactElement<Record<string, any>>;

const oak: WorktreeView = { path: "/wt/oak", name: "oak", branch: "feat/oak", head: null, start: null, primary: false, pinned: false, detached: false };
const elm: WorktreeView = { ...oak, path: "/wt/elm", name: "elm", branch: "feat/elm" };
const repos: RepoView[] = [{ id: "x", shortName: "xdev", path: "/r/x", baseRef: "origin/main", worktreeRoot: "/wt", missing: false, worktrees: [oak, elm], found: [] }];
const tabOf = (id: string, worktree: string, profileId: string, agent: boolean): Tab => ({ id, worktree, profileId, account: null, permissions: "ask", agent, status: "idle" } as Tab);

beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false;
  store.view = { defaultAgent: "codex", profiles: [], shells: [{ id: "shell-pwsh", name: "PowerShell" }] };
});

function host(over: Partial<PaletteHostProps> = {}) {
  const actions: PaletteActions = { selectWorktree: vi.fn(), frontTab: vi.fn(), showWorkspace: vi.fn(), openSettings: vi.fn(), newWorktree: vi.fn(), addRepo: vi.fn(), searchDocs: vi.fn(), toggleSidebar: vi.fn(), showDocs: vi.fn() };
  const open = vi.fn((worktree: string, profile: string) => tabOf("new1", worktree, profile, true));
  const tabs: Record<string, Tab[]> = { "/wt/oak": [tabOf("p1", "/wt/oak", "claude", true)], "/wt/elm": [tabOf("p2", "/wt/elm", "shell", false)] };
  const sessions = { tabs: (p: string) => tabs[p] ?? [], dot: () => null, lastActivity: () => null, open } as unknown as Sessions;
  const props: PaletteHostProps = { open: true, onClose: vi.fn(), repos, sessions, current: oak, shownTab: "p1", actions, ...over };
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return PaletteHost(props) as Node; } finally { hooks.active = false; }
  };
  const palette = () => draw().props as { items: { id: string; title: string; status?: string; run(): void }[] };
  const item = (id: string) => palette().items.find((i) => i.id === id)!;
  return { actions, open, props, draw, palette, item };
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
