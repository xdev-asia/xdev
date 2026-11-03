import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi, type WorktreeChange, type WorktreeView } from "@/api";
import { DocsApp } from "@/DocsApp";
import { DEMO_WORKSPACE } from "@/mockWorkspace";
import { translate } from "@/i18n";
import { ChecksPanel } from "./ChecksPanel";
import { CreateWorktreeDialog } from "./CreateWorktreeDialog";
import { RemoveWorktreeDialog } from "./RemoveWorktreeDialog";
import { FileTree } from "./FileTree";
import { HeaderSearch } from "./HeaderSearch";
import { VaultNav } from "./VaultNav";
import { PaletteHost } from "@/palette/PaletteHost";
import { SettingsView } from "@/settings/SettingsView";
import { Sessions } from "./sessions";
import { WorkspaceShell } from "./WorkspaceShell";
import { WorktreeChanges } from "./WorktreeChanges";
import { WorktreeList } from "./WorktreeList";
import { WorktreeTabs } from "./WorktreeTabs";

// Hooks are stubbed only while the shell itself is called; children rendered to markup use React's own.
const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0, effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const state = (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value; }];
  };
  return {
    ...react,
    // The profile store is outside what these tests render; its context keeps the default.
    useContext: (ctx: { _currentValue: unknown }) => ctx._currentValue,
    useState: (initial: any) => (hooks.active ? state(initial) : react.useState(initial)),
    useEffect: (effect: any, deps?: any) => (hooks.active ? void hooks.effects.push(effect) : react.useEffect(effect, deps)),
    useCallback: (fn: any, deps: any) => (hooks.active ? fn : react.useCallback(fn, deps)),
    useSyncExternalStore: (subscribe: any, get: any, server?: any) => (hooks.active ? get() : react.useSyncExternalStore(subscribe, get, server)),
  };
});
const jump = vi.hoisted(() => ({ toggle: null as null | (() => void) }));
vi.mock("@/palette/useJumpKey", () => ({ useJumpKey: (fn: () => void) => { jump.toggle = fn; } }));
// xterm needs a real canvas; the terminals are tested on their own.
vi.mock("@/terminal/Terminal", () => ({ Terminal: () => null }));
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const text = (node: Node): string => nodes(node.props.children).map(n => (typeof n.props.children === "string" ? n.props.children : "")).join("") + (typeof node.props.children === "string" ? node.props.children : "");
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
// The shell's effects in order: the sessions store, the worktree list, the pull request of the selection.
const EFFECTS = 3;

async function harness(api = createMockApi({})) {
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return WorkspaceShell({ api }); } finally { hooks.active = false; }
  };
  const all = () => nodes(draw());
  const html = () => renderToStaticMarkup(draw());
  const of = (type: unknown) => all().filter(n => n.type === type);
  const list = () => of(WorktreeList)[0];
  const nav = (label: string) => all().find(n => n.type === "button" && n.props.className?.includes("ws-nav-item") && text(n).includes(label))!;
  const [start, load] = (draw(), hooks.effects.slice(-EFFECTS, -1));
  start();
  load();
  await tick();
  const worktree = (name: string) => list().props.repos.flatMap((r: { worktrees: WorktreeView[] }) => r.worktrees).find((w: WorktreeView) => w.name === name) as WorktreeView;
  return { api, draw, all, html, of, list, nav, worktree };
}

function storage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) };
}

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false; });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("shell_renders_without_vault", async () => {
  const api = createMockApi({});
  const lastVault = vi.spyOn(api, "lastVault");
  const setup = vi.spyOn(api, "vaultSetup");
  const view = await harness(api);
  const html = view.html();
  expect(html).toContain("xDev");
  expect(html).toContain(en("workspace.nav.workspace"));
  // Markup escapes the ampersand of "Docs & SDLC".
  expect(html).toContain(en("workspace.nav.docs").replace(/&/g, "&amp;"));
  for (const name of ["oak", "elm"]) expect(html).toContain(`>${name}<`);
  // Nothing selected yet: the first worktree, the primary checkout on main.
  expect(html).toContain("⎇ main");
  expect(html).toContain(en("workspace.footer.running", { count: 0 }));
  // The main checkout has no changes list.
  expect(html).toContain(en("workspace.changes.primary"));
  expect(view.of(DocsApp)).toHaveLength(0);
  expect(html).not.toContain("vault-dialog");
  expect(lastVault).not.toHaveBeenCalled();
  expect(setup).not.toHaveBeenCalled();
});

it("header has repo, branch, search, bell and settings", async () => {
  const view = await harness();
  const box = { focus: vi.fn(), select: vi.fn() };
  const query = vi.fn(() => box);
  vi.stubGlobal("document", { querySelector: query });
  const header = view.all().find(n => n.type === "header")!;
  const inHeader = nodes(header.props.children);
  const crumbs = inHeader.filter(n => String(n.props.className ?? "").includes("ws-crumb") && !String(n.props.className).includes("sep")).map(text);
  expect(crumbs).toEqual(["xdev", "main"]);
  expect(inHeader.filter(n => n.type === HeaderSearch)).toHaveLength(1);
  const named = (label: string) => inHeader.find(n => n.type === "button" && n.props["aria-label"] === label);
  expect(named(en("workspace.header.notifications"))).toBeDefined();
  expect(named(en("workspace.header.settings"))).toBeDefined();
  // The search opens the docs app, the only search there is for now.
  expect(view.of(DocsApp)).toHaveLength(0);
  vi.useFakeTimers();
  inHeader.find(n => n.type === HeaderSearch)!.props.onOpen();
  expect(view.of(DocsApp)).toHaveLength(1);
  vi.runAllTimers();
  vi.useRealTimers();
  expect(query).toHaveBeenCalledWith(".ws-docs .search-input");
  expect(box.focus).toHaveBeenCalledTimes(1);
});

it("header settings button opens settings", async () => {
  const api = createMockApi({});
  const view = await harness(api);
  const region = (cls: string) => view.all().find(n => n.props.className === cls)!;
  const button = () => view.all().find(n => n.type === "button" && n.props["aria-label"] === en("workspace.header.settings"))!;
  expect(button().props.disabled).toBeFalsy();
  expect(button().props["aria-pressed"]).toBe(false);
  expect(view.of(SettingsView)).toHaveLength(0);
  expect(region("ws-settings").props.hidden).toBe(true);

  button().props.onClick();
  expect(button().props["aria-pressed"]).toBe(true);
  expect(region("ws-settings").props.hidden).toBe(false);
  expect(region("ws-stage").props.hidden).toBe(true);
  const settings = view.of(SettingsView)[0];
  expect(settings.props.api).toBe(api);
  // A change in settings reloads the worktree list.
  const list = vi.spyOn(api, "workspaceList");
  settings.props.onChanged();
  await tick();
  expect(list).toHaveBeenCalledTimes(1);

  view.nav(en("workspace.nav.workspace")).props.onClick();
  expect(view.of(SettingsView)).toHaveLength(0);
  expect(region("ws-stage").props.hidden).toBe(false);
});

it("adopting refreshes the list", async () => {
  const spike: WorktreeView = { path: "/demo/elsewhere/spike", name: "spike", branch: "spike", head: "6666666666666666666666666666666666666666", start: null, primary: false, pinned: false, detached: false };
  const api = createMockApi({}, { workspace: { ...structuredClone(DEMO_WORKSPACE), found: { "demo-xdev": [spike] } } });
  const view = await harness(api);
  expect(view.list().props.repos[0].found).toHaveLength(1);
  const adopt = vi.spyOn(api, "worktreeAdopt");
  view.list().props.onAdopt(spike);
  await tick();
  expect(adopt).toHaveBeenCalledWith("/demo/elsewhere/spike");
  expect(view.list().props.repos[0].found).toHaveLength(0);
  expect(view.worktree("spike")?.path).toBe("/demo/elsewhere/spike");

  // A second adopt of the same path is refused, and the reason shows in the list.
  view.list().props.onAdopt(spike);
  await tick();
  expect(view.list().props.notice).toBe("worktree_exists");
});

it("opening a vault from the nav remounts docs", async () => {
  const view = await harness();
  expect(view.of(VaultNav)).toHaveLength(0);
  view.nav(en("workspace.nav.docs")).props.onClick();
  const [nav] = view.of(VaultNav);
  expect(nav).toBeDefined();
  const key = () => view.of(DocsApp)[0].key;
  const before = key();
  nav.props.onOpened("/demo/xdev/docs");
  expect(view.of(DocsApp)).toHaveLength(1);
  expect(key()).not.toBe(before);
  // The vault list goes with the docs view.
  view.nav(en("workspace.nav.workspace")).props.onClick();
  expect(view.of(VaultNav)).toHaveLength(0);
});

it("docs nav mounts the docs app once and keeps the workspace mounted", async () => {
  const view = await harness();
  const region = (cls: string) => view.all().find(n => n.props.className === cls)!;
  const crumbs = () => view.all().filter(n => String(n.props.className ?? "").includes("ws-crumb"));
  expect(crumbs().length).toBeGreaterThan(0);
  view.nav(en("workspace.nav.docs")).props.onClick();
  // The docs app has its own folder bar, so the shell drops the repo and branch crumbs.
  expect(crumbs()).toHaveLength(0);
  expect(view.of(DocsApp)).toHaveLength(1);
  expect(region("ws-docs").props.hidden).toBe(false);
  expect(region("ws-stage").props.hidden).toBe(true);
  expect(view.of(WorktreeList)).toHaveLength(1);
  expect(view.nav(en("workspace.nav.docs")).props["aria-current"]).toBe("page");

  view.nav(en("workspace.nav.workspace")).props.onClick();
  expect(view.of(DocsApp)).toHaveLength(1);
  expect(region("ws-docs").props.hidden).toBe(true);
  expect(region("ws-stage").props.hidden).toBe(false);
  expect(crumbs().length).toBeGreaterThan(0);

  view.nav(en("workspace.nav.docs")).props.onClick();
  expect(view.of(DocsApp)).toHaveLength(1);
});

it("remembers the selected worktree and falls back to the first", async () => {
  const store = storage({ "xdev.workspace.selected": "/demo/wt/xdev-elm" });
  vi.stubGlobal("localStorage", store);
  let view = await harness();
  expect(view.list().props.selected).toBe("/demo/wt/xdev-elm");
  expect(view.html()).toContain("⎇ elm");
  view.list().props.onSelect(view.worktree("oak"));
  expect(store.map.get("xdev.workspace.selected")).toBe("/demo/wt/xdev-oak");
  expect(view.html()).toContain("⎇ oak");

  hooks.values = [];
  store.map.set("xdev.workspace.selected", "/gone");
  view = await harness();
  expect(view.list().props.selected).toBe("/demo/xdev");
});

it("add repo picks a folder and shows the new repo", async () => {
  const api = createMockApi({});
  const pick = vi.spyOn(api, "pickFolder").mockResolvedValueOnce(null).mockResolvedValueOnce("/code/notes");
  const add = vi.spyOn(api, "repoAdd");
  const view = await harness(api);
  await view.list().props.onAddRepo();
  await tick();
  expect(add).not.toHaveBeenCalled();

  await view.list().props.onAddRepo();
  await tick();
  expect(pick).toHaveBeenCalledTimes(2);
  expect(add).toHaveBeenCalledWith("/code/notes");
  expect(view.list().props.repos.map((r: { shortName: string }) => r.shortName)).toEqual(["xdev", "notes"]);
  expect(view.list().props.selected).toBe("/code/notes");
  expect(view.html()).toContain(">notes<");

  // Adding it again keeps the list and says why.
  vi.spyOn(api, "pickFolder").mockResolvedValueOnce("/code/notes");
  await view.list().props.onAddRepo();
  await tick();
  expect(view.list().props.repos).toHaveLength(2);
  expect(view.html()).toContain(en("error.repo_exists"));
});

it("create shows branch_exists inline", async () => {
  const api = createMockApi({});
  const create = vi.spyOn(api, "worktreeCreate");
  const view = await harness(api);
  expect(view.of(CreateWorktreeDialog)).toHaveLength(0);
  view.list().props.onCreate();
  const dialog = () => view.of(CreateWorktreeDialog)[0];
  expect(dialog().props.repoId).toBe("demo-xdev");
  const markup = renderToStaticMarkup(dialog());
  expect(markup).toContain('placeholder="auto"');
  expect(markup).toContain('placeholder="main"');

  dialog().props.onCreate("demo-xdev", "oak", null);
  await tick();
  expect(create).toHaveBeenCalledWith("demo-xdev", "oak", null);
  expect(dialog().props.error).toBe("branch_exists");
  expect(renderToStaticMarkup(dialog())).toContain(en("error.branch_exists"));

  dialog().props.onCreate("demo-xdev", "birch", null);
  await tick();
  expect(view.of(CreateWorktreeDialog)).toHaveLength(0);
  expect(view.list().props.selected).toBe("/demo/wt/xdev-birch");
  expect(view.html()).toContain("⎇ birch");
});

it("delete asks, closes sessions, then removes; dirty needs the second step", async () => {
  const close = vi.spyOn(Sessions.prototype, "closeWorktree");
  const api = createMockApi({});
  const remove = vi.spyOn(api, "worktreeRemove");
  const view = await harness(api);
  const dialog = () => view.of(RemoveWorktreeDialog)[0];

  view.list().props.onRemove(view.worktree("oak"));
  expect(close).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  let markup = renderToStaticMarkup(dialog());
  expect(markup).toContain("/demo/wt/xdev-oak");
  expect(markup).toContain(">oak<");
  expect(markup).not.toContain(en("workspace.remove.force"));

  dialog().props.onConfirm();
  await tick();
  expect(close).toHaveBeenCalledWith("/demo/wt/xdev-oak");
  expect(remove).toHaveBeenCalledWith("/demo/wt/xdev-oak", false, true);
  expect(close.mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[0]);
  expect(dialog().props.dirty).toBe(true);
  markup = renderToStaticMarkup(dialog());
  expect(markup).toContain(en("workspace.remove.force"));
  expect(markup).toContain(en("error.worktree_dirty"));
  expect(view.worktree("oak")).toBeDefined();

  dialog().props.onConfirm();
  await tick();
  expect(remove).toHaveBeenLastCalledWith("/demo/wt/xdev-oak", true, true);
  expect(view.of(RemoveWorktreeDialog)).toHaveLength(0);
  expect(view.worktree("oak")).toBeUndefined();

  // A clean worktree goes on the first confirm.
  view.list().props.onRemove(view.worktree("elm"));
  dialog().props.onConfirm();
  await tick();
  expect(remove).toHaveBeenLastCalledWith("/demo/wt/xdev-elm", false, true);
  expect(view.of(RemoveWorktreeDialog)).toHaveLength(0);
  expect(view.worktree("elm")).toBeUndefined();
});

it("a worktree that leaves the list has its terminals closed", async () => {
  const close = vi.spyOn(Sessions.prototype, "closeWorktree");
  const api = createMockApi({});
  const view = await harness(api);
  const sessions = view.of(WorktreeTabs)[0].props.sessions as Sessions;
  sessions.open("/demo/wt/xdev-oak", "shell");
  sessions.open("/demo/xdev", "shell");
  const real = api.workspaceList.bind(api);
  vi.spyOn(api, "workspaceList").mockImplementation(async () =>
    (await real()).map(r => ({ ...r, worktrees: r.worktrees.filter(w => w.path !== "/demo/wt/xdev-oak") })),
  );
  // Any reload notices; here, a pin.
  view.list().props.onPin(view.worktree("elm"));
  await tick();
  expect(close).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledWith("/demo/wt/xdev-oak");
});

it("a missing repo keeps its worktrees' terminals", async () => {
  const close = vi.spyOn(Sessions.prototype, "closeWorktree");
  const api = createMockApi({});
  const view = await harness(api);
  const sessions = view.of(WorktreeTabs)[0].props.sessions as Sessions;
  sessions.open("/demo/wt/xdev-oak", "shell");
  const real = api.workspaceList.bind(api);
  // The repo's folder is unreachable for now, so it comes back with no worktrees.
  vi.spyOn(api, "workspaceList").mockImplementation(async () =>
    (await real()).map(r => (r.worktrees.some(w => w.path === "/demo/wt/xdev-oak") ? { ...r, missing: true, worktrees: [] } : r)),
  );
  view.list().props.onPin(view.worktree("elm"));
  await tick();
  expect(close).not.toHaveBeenCalled();
});

it("switching worktrees keeps every visited worktree's tabs mounted", async () => {
  const view = await harness();
  const tabs = () => view.of(WorktreeTabs).map(n => [n.props.worktree, n.props.visible]);
  expect(tabs()).toEqual([["/demo/xdev", true]]);
  const sessions = view.of(WorktreeTabs)[0].props.sessions as Sessions;
  const oakTab = sessions.open("/demo/wt/xdev-oak", "shell");

  view.list().props.onSelect(view.worktree("oak"));
  expect(tabs()).toEqual([["/demo/xdev", false], ["/demo/wt/xdev-oak", true]]);
  view.list().props.onSelect(view.worktree("elm"));
  expect(tabs()).toEqual([["/demo/xdev", false], ["/demo/wt/xdev-oak", false], ["/demo/wt/xdev-elm", true]]);
  // The hidden worktree still renders its terminal, so its pty keeps running.
  expect(view.html()).toContain(`data-tab="${oakTab.id}"`);
});

it("changes tab counts the worktree's files and opens a diff next to the terminals", async () => {
  const view = await harness();
  const panel = () => view.of(WorktreeChanges)[0];
  const tab = () => view.all().find(n => n.props.className === "ws-panel-tab" && n.props["aria-label"].startsWith(en("workspace.panel.changes")))!;
  expect(panel().props.worktree.path).toBe("/demo/xdev");
  expect(tab().props["aria-label"]).toBe(en("workspace.panel.changes"));

  view.list().props.onSelect(view.worktree("oak"));
  expect(panel().props.worktree.path).toBe("/demo/wt/xdev-oak");
  expect(panel().props.sessions).toBe(view.of(WorktreeTabs)[0].props.sessions);
  panel().props.onCount(3);
  expect(tab().props["aria-label"]).toBe(en("workspace.panel.changesCount", { count: 3 }));
  expect(renderToStaticMarkup(tab())).toContain(">3<");

  const oak = () => view.of(WorktreeTabs).find(n => n.props.worktree === "/demo/wt/xdev-oak")!;
  expect(oak().props.reveal).toBeUndefined();
  panel().props.onOpenFile("src/session.ts");
  expect(oak().props.reveal).toEqual({ file: "src/session.ts", seq: 1 });
  panel().props.onOpenFile("src/session.ts");
  expect(oak().props.reveal).toEqual({ file: "src/session.ts", seq: 2 });
  // Other worktrees get no file, and their count is not this one's.
  expect(view.of(WorktreeTabs).find(n => n.props.worktree === "/demo/xdev")!.props.reveal).toBeUndefined();
  view.list().props.onSelect(view.worktree("elm"));
  expect(tab().props["aria-label"]).toBe(en("workspace.panel.changes"));
});

it("hands the list the line counts, times and agents of each worktree", async () => {
  const api = createMockApi({});
  const read = vi.spyOn(api, "worktreeStat");
  const view = await harness(api);
  // One read per listed worktree when the list loads; the counts reach the rows.
  await tick();
  expect(read.mock.calls.map(c => c[0]).sort()).toEqual(["/demo/wt/xdev-elm", "/demo/wt/xdev-oak", "/demo/xdev"]);
  const props = view.list().props;
  expect(props.stats["/demo/wt/xdev-oak"]).toEqual({ files: 3, added: 4, removed: 3 });
  expect(props.activity["/demo/wt/xdev-oak"]).toBeNull();
  expect(props.profiles["/demo/wt/xdev-oak"]).toEqual([]);
  expect(typeof props.now).toBe("number");
});

it("panel has Files and Changes icon tabs with a change badge", async () => {
  const view = await harness();
  const tabs = () => view.all().filter(n => n.props.className === "ws-panel-tab");
  const files = () => tabs()[0];
  const changes = () => tabs()[1];
  // Icon buttons: a name for screen readers and no visible text.
  expect(tabs().map(n => n.props["aria-label"])).toEqual([en("workspace.panel.files"), en("workspace.panel.changes"), en("checks.tab")]);
  expect(tabs().every(n => n.props.role === "tab" && n.type === "button")).toBe(true);
  expect(renderToStaticMarkup(files())).not.toContain("ws-panel-badge");
  // Files is the default tab, and the tree and the changes list are both mounted.
  expect(tabs().map(n => n.props["aria-selected"])).toEqual([true, false, false]);
  const panels = () => view.all().filter(n => n.props.role === "tabpanel");
  expect(panels().map(n => n.props.hidden)).toEqual([false, true, true]);
  expect(view.of(FileTree)).toHaveLength(1);
  expect(view.of(WorktreeChanges)).toHaveLength(1);

  view.list().props.onSelect(view.worktree("oak"));
  expect(view.of(FileTree)[0].props.worktree).toBe("/demo/wt/xdev-oak");
  expect(view.of(FileTree)[0].props.changes).toEqual([]);
  // The tree gets the list the Changes panel read, so it can mark files.
  const list: WorktreeChange[] = [{ path: "src/session.ts", kind: "modified" }];
  view.of(WorktreeChanges)[0].props.onChanges(list);
  view.of(WorktreeChanges)[0].props.onCount(1);
  expect(view.of(FileTree)[0].props.changes).toBe(list);
  expect(renderToStaticMarkup(changes())).toContain(">1<");
  expect(changes().props["aria-label"]).toBe(en("workspace.panel.changesCount.one", { count: 1 }));

  // Opening a changed file from the tree opens its diff, like the Changes list does.
  const oak = () => view.of(WorktreeTabs).find(n => n.props.worktree === "/demo/wt/xdev-oak")!;
  view.of(FileTree)[0].props.onOpen("src/session.ts");
  expect(oak().props.reveal).toEqual({ file: "src/session.ts", seq: 1 });

  changes().props.onClick();
  expect(tabs().map(n => n.props["aria-selected"])).toEqual([false, true, false]);
  expect(panels().map(n => n.props.hidden)).toEqual([true, false, true]);
  // Another worktree has its own list.
  view.list().props.onSelect(view.worktree("elm"));
  expect(view.of(FileTree)[0].props.changes).toEqual([]);
});

it("checks tab badge counts failing checks", async () => {
  const oak = "/demo/wt/xdev-oak";
  const pr = { number: 5, url: "https://example.test/pull/5", state: "open" as const, title: "t", base: "main", head: "oak" };
  const checks = [
    { name: "a", workflow: null, bucket: "fail" as const, link: null },
    { name: "b", workflow: null, bucket: "cancel" as const, link: null },
    { name: "c", workflow: null, bucket: "pass" as const, link: null },
  ];
  const view = await harness(createMockApi({}, { workspace: { ...DEMO_WORKSPACE, prs: { [oak]: pr }, checks: { [oak]: checks } } }));
  const tab = () => view.all().find(n => n.props.className === "ws-panel-tab" && String(n.props["aria-label"]).startsWith(en("checks.tab")))!;
  view.list().props.onSelect(view.worktree("oak"));
  expect(tab().props["aria-label"]).toBe(en("checks.tab"));
  expect(view.list().props.prs).toEqual({});
  const store = view.of(ChecksPanel)[0].props.prs;
  await store.load(oak, { checks: true });
  expect(tab().props["aria-label"]).toBe(en("checks.tabFailing", { count: 2 }));
  expect(renderToStaticMarkup(tab())).toContain(">2<");
  expect(view.list().props.prs[oak].pr.number).toBe(5);
});

// Creates a worktree through the dialog; hands back the tabs it opened with.
async function createBirch(view: Awaited<ReturnType<typeof harness>>) {
  view.list().props.onCreate();
  view.of(CreateWorktreeDialog)[0].props.onCreate("demo-xdev", "birch", null);
  await tick();
  await tick();
  expect(view.list().props.selected).toBe("/demo/wt/xdev-birch");
  const sessions = view.of(WorktreeTabs)[0].props.sessions as Sessions;
  return sessions.tabs("/demo/wt/xdev-birch").map(t => t.profileId);
}

it("new_worktree_opens_default_agent", async () => {
  const api = createMockApi({});
  await api.profilesDefaults("ask", "codex", null);
  const view = await harness(api);
  expect(await createBirch(view)).toEqual(["codex"]);
});

it("new_worktree_skips_uninstalled_default", async () => {
  const api = createMockApi({});
  // Gemini is not installed in the mock.
  await api.profilesDefaults("ask", "gemini", null);
  const view = await harness(api);
  expect(await createBirch(view)).toEqual([]);
});

it("new worktree skips a default agent that is turned off", async () => {
  const api = createMockApi({});
  const codex = (await api.profiles()).profiles.find(p => p.profile.id === "codex")!.profile;
  await api.profilePut({ ...codex, enabled: false });
  await api.profilesDefaults("ask", "codex", null);
  const view = await harness(api);
  expect(await createBirch(view)).toEqual([]);
});

it("the header button opens the jump palette and its actions reach the shell", async () => {
  const view = await harness();
  expect(view.of(PaletteHost)[0].props.open).toBe(false);
  view.of(HeaderSearch)[0].props.onJump();
  expect(view.of(PaletteHost)[0].props.open).toBe(true);
  view.of(PaletteHost)[0].props.onClose();
  expect(view.of(PaletteHost)[0].props.open).toBe(false);
  // A new worktree typed into the palette opens the dialog with that name.
  view.of(PaletteHost)[0].props.actions.newWorktree("fix-it");
  expect(view.of(CreateWorktreeDialog)[0].props.name).toBe("fix-it");
  // Opening settings on a section shows that section.
  view.of(PaletteHost)[0].props.actions.openSettings("repos");
  expect(view.of(SettingsView)[0].props.initial).toBe("repos");
});

it("the header settings button drops a section the palette asked for", async () => {
  const view = await harness();
  const button = () => view.all().find(n => n.type === "button" && n.props["aria-label"] === en("workspace.header.settings"))!;
  view.of(PaletteHost)[0].props.actions.openSettings("repos");
  expect(view.of(SettingsView)[0].props.initial).toBe("repos");
  view.nav(en("workspace.nav.workspace")).props.onClick();
  button().props.onClick();
  expect(view.of(SettingsView)[0].props.initial).toBeUndefined();
});

it("the palette's showWorkspace leaves settings", async () => {
  const view = await harness();
  view.of(PaletteHost)[0].props.actions.openSettings();
  expect(view.of(SettingsView)).toHaveLength(1);
  view.of(PaletteHost)[0].props.actions.showWorkspace();
  expect(view.of(SettingsView)).toHaveLength(0);
});

it("ctrl+j does not open the palette over a worktree dialog", async () => {
  const view = await harness();
  view.of(PaletteHost)[0].props.actions.newWorktree();
  expect(view.of(CreateWorktreeDialog)).toHaveLength(1);
  view.draw();
  jump.toggle!();
  expect(view.of(PaletteHost)[0].props.open).toBe(false);
  view.of(CreateWorktreeDialog)[0].props.onCancel();
  view.draw();
  jump.toggle!();
  expect(view.of(PaletteHost)[0].props.open).toBe(true);
  view.draw();
  jump.toggle!();
  view.list().props.onRemove(view.worktree("oak"));
  expect(view.of(RemoveWorktreeDialog)).toHaveLength(1);
  view.draw();
  jump.toggle!();
  expect(view.of(PaletteHost)[0].props.open).toBe(false);
});
