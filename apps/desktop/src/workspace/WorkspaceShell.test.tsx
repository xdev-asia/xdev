import { BADGE_DEBOUNCE_MS } from "./notifier";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SETUP_PROFILE, createMockApi, type WorktreeChange, type WorktreeView } from "@/api";
import { DocsApp } from "@/DocsApp";
import { DEMO_WORKSPACE } from "@/mockWorkspace";
import { translate } from "@/i18n";
import { ChecksPanel } from "./ChecksPanel";
import { IssuesPanel } from "@/issues/IssuesPanel";
import { AddProjectDialog } from "./AddProjectDialog";
import { CreateWorktreeDialog } from "./CreateWorktreeDialog";
import { resetNavigationSettingsForTests, setNavigationSettings } from "@/settings/navigationSettings";
import { NAVIGATION_DEFAULTS } from "@/settings/generalDefaults";
import { RemoveWorktreeDialog } from "./RemoveWorktreeDialog";
import { BulkRemoveDialog } from "./BulkRemoveDialog";
import { dismissToast, getToasts } from "./toastStore";
import { SetupCard } from "./SetupCard";
import { TrustDialog } from "./TrustDialog";
import { FileTree } from "./FileTree";
import { HeaderSearch } from "./HeaderSearch";
import { VaultNav } from "./VaultNav";
import { PaletteHost } from "@/palette/PaletteHost";
import { SettingsView } from "@/settings/SettingsView";
import { resetStatusSettings } from "@/status/statusSettings";
import { BellMenu } from "./BellMenu";
import { Sessions } from "./sessions";
import { LiveWorkspaceFooter } from "./WorkspaceFooter";
import { WorkspaceShell } from "./WorkspaceShell";
import { WorktreeChanges } from "./WorktreeChanges";
import { WorktreeList } from "./WorktreeList";
import { WorktreeTabs } from "./WorktreeTabs";
import { Toasts } from "./Toasts";
import { SessionsSidebar } from "@/agentSessions/SessionsSidebar";
import { NO_DETAILS } from "@/workspace/worktreeDetails";

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
    useRef: (initial: any) => (hooks.active ? (state({ current: initial }) as [{ current: unknown }])[0] : react.useRef(initial)),
    useCallback: (fn: any, deps: any) => (hooks.active ? fn : react.useCallback(fn, deps)),
    useSyncExternalStore: (subscribe: any, get: any, server?: any) => (hooks.active ? get() : react.useSyncExternalStore(subscribe, get, server)),
  };
});
// No audio in node; the shell is checked for asking, the sound itself in its own tests.
const sound = vi.hoisted(() => ({ play: vi.fn(async () => true) }));
vi.mock("@/status/sound", async (original) => ({ ...await original<typeof import("@/status/sound")>(), playStatusSound: sound.play }));
const jump = vi.hoisted(() => ({ toggle: null as null | (() => void) }));
vi.mock("@/palette/useJumpKey", () => ({ useJumpKey: (fn: () => void) => { jump.toggle = fn; } }));
// The worktree keys: the shell's handlers are called straight, the keymap itself is tested on its own.
const keymap = vi.hoisted(() => ({ handlers: {} as Record<string, () => boolean | void>, when: (() => true) as () => boolean }));
vi.mock("@/keys/keymap", async (original) => ({
  ...await original<typeof import("@/keys/keymap")>(),
  // A shell calls useKeymap more than once; the handlers add up, and `when` is the last call's.
  useKeymap: (handlers: Record<string, () => boolean | void>, opts?: { when?: () => boolean }) => { keymap.handlers = { ...keymap.handlers, ...handlers }; keymap.when = opts?.when ?? (() => true); },
}));
const termKey = vi.hoisted(() => ({ host: null as null | { t: (k: string) => string; openShortcuts: (a: string) => void } }));
vi.mock("@/keys/terminalKey", async (original) => ({ ...await original<typeof import("@/keys/terminalKey")>(), setTerminalKeyHost: (h: typeof termKey.host) => { termKey.host = h; } }));
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

const reposOf = (n: Node): any[] => (n.props.items as { kind: string; repo?: unknown }[]).flatMap((i) => (i.kind === "repo" ? [i.repo] : []));

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
  // The shell's first two effects: the sessions store, then the worktree list.
  const [start, load] = (draw(), hooks.effects.slice(0, 2));
  start();
  load();
  await tick();
  const worktree = (name: string) => reposOf(list()).flatMap((r: { worktrees: WorktreeView[] }) => r.worktrees).find((w: WorktreeView) => w.name === name) as WorktreeView;
  return { api, draw, all, html, of, list, nav, worktree };
}

function storage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) };
}

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false; sound.play.mockClear(); resetStatusSettings(); resetNavigationSettingsForTests(); });
afterEach(() => { cleanups.splice(0).forEach((c) => c()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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
  const list = vi.spyOn(api, "workspaceSidebar");
  settings.props.onChanged();
  await tick();
  expect(list).toHaveBeenCalledTimes(1);

  view.nav(en("workspace.nav.workspace")).props.onClick();
  expect(view.of(SettingsView)).toHaveLength(0);
  expect(region("ws-stage").props.hidden).toBe(false);
});

it("adopting refreshes the list", async () => {
  const spike: WorktreeView = { path: "/demo/elsewhere/spike", name: "spike", branch: "spike", head: "6666666666666666666666666666666666666666", start: null, primary: false, pinned: false, detached: false, ...NO_DETAILS };
  const api = createMockApi({}, { workspace: { ...structuredClone(DEMO_WORKSPACE), found: { "demo-xdev": [spike] } } });
  const view = await harness(api);
  expect(reposOf(view.list())[0].found).toHaveLength(1);
  const adopt = vi.spyOn(api, "worktreeAdopt");
  view.list().props.onAdopt(spike);
  await tick();
  expect(adopt).toHaveBeenCalledWith("/demo/elsewhere/spike");
  expect(reposOf(view.list())[0].found).toHaveLength(0);
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

it("add repo opens the dialog; Open folder picks a folder and shows the new repo", async () => {
  const api = createMockApi({});
  const pick = vi.spyOn(api, "pickFolder").mockResolvedValueOnce(null).mockResolvedValueOnce("/code/notes");
  const add = vi.spyOn(api, "repoAdd");
  const view = await harness(api);
  const openFolder = async () => {
    view.list().props.onAddRepo();
    await view.of(AddProjectDialog)[0].props.onOpenFolder();
    await tick();
  };
  view.list().props.onAddRepo();
  expect(view.of(AddProjectDialog)).toHaveLength(1);
  expect(pick).not.toHaveBeenCalled();
  view.of(AddProjectDialog)[0].props.onCancel();
  expect(view.of(AddProjectDialog)).toHaveLength(0);

  await openFolder();
  expect(view.of(AddProjectDialog)).toHaveLength(0);
  expect(add).not.toHaveBeenCalled();

  await openFolder();
  expect(pick).toHaveBeenCalledTimes(2);
  expect(add).toHaveBeenCalledWith("/code/notes");
  expect(reposOf(view.list()).map((r: { shortName: string }) => r.shortName)).toEqual(["xdev", "notes"]);
  expect(view.list().props.selected).toBe("/code/notes");
  expect(view.html()).toContain(">notes<");

  // Adding it again keeps the list and says why.
  vi.spyOn(api, "pickFolder").mockResolvedValueOnce("/code/notes");
  await openFolder();
  expect(reposOf(view.list())).toHaveLength(2);
  expect(view.html()).toContain(en("error.repo_exists"));
});

it("the create dialog gets the name preview from the api", async () => {
  const api = createMockApi({});
  const view = await harness(api);
  view.list().props.onCreate();
  const preview = view.of(CreateWorktreeDialog)[0].props.namePreview;
  expect(await preview("demo-xdev", "oak")).toMatchObject({ branch: "oak-2", suffixed: true });
});

it("a created Git project closes the dialog and is selected; a folder is listed", async () => {
  const api = createMockApi({});
  const view = await harness(api);
  view.list().props.onAddRepo();
  const git = await api.repoCreate({ parent: "/code", name: "fresh", kind: "git", branch: "", firstCommit: true });
  await view.of(AddProjectDialog)[0].props.onCreated(git);
  await tick();
  expect(view.of(AddProjectDialog)).toHaveLength(0);
  expect(view.list().props.selected).toBe("/code/fresh");
  view.list().props.onAddRepo();
  const folder = await api.repoCreate({ parent: "/code", name: "scratch", kind: "folder", branch: "", firstCommit: false });
  await view.of(AddProjectDialog)[0].props.onCreated(folder);
  await tick();
  expect(view.of(AddProjectDialog)).toHaveLength(0);
  expect(view.list().props.selected).toBe("/code/fresh");
  expect((await api.workspaceSidebar()).some((i) => i.kind === "folder" && i.folder.name === "scratch")).toBe(true);
});

it("a finished clone closes the dialog and selects the new repo", async () => {
  const api = createMockApi({});
  const view = await harness(api);
  view.list().props.onAddRepo();
  expect(view.of(AddProjectDialog)[0].props.startFolder).toBe("/demo");
  const repo = await api.repoAdd("/code/cloned");
  await view.of(AddProjectDialog)[0].props.onCloned(repo);
  await tick();
  expect(view.of(AddProjectDialog)).toHaveLength(0);
  expect(view.list().props.selected).toBe("/code/cloned");
});

it("create closes the dialog at once; a failure stays as a row with Retry and Dismiss", async () => {
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

  dialog().props.onCreate("demo-xdev", "...", null);
  expect(view.of(CreateWorktreeDialog)).toHaveLength(0);
  expect(view.list().props.pending).toMatchObject([{ name: "...", state: "running" }]);
  await tick();
  expect(create).toHaveBeenCalledWith("demo-xdev", "...", null);
  const [failed] = view.list().props.pending;
  expect(failed).toMatchObject({ name: "...", state: "failed", error: { code: "bad_name" } });
  view.list().props.onRetryCreate(failed.id);
  await tick();
  expect(create).toHaveBeenCalledTimes(2);
  expect(view.list().props.pending[0].state).toBe("failed");
  view.list().props.onDismissCreate(failed.id);
  expect(view.list().props.pending).toEqual([]);

  view.list().props.onCreate();
  dialog().props.onCreate("demo-xdev", "birch", null);
  await tick();
  await tick();
  expect(view.list().props.pending).toEqual([]);
  expect(view.list().props.selected).toBe("/demo/wt/xdev-birch");
  expect(view.html()).toContain("⎇ birch");
});

it("a create cancelled while running is removed once it lands, and nothing is selected", async () => {
  const api = createMockApi({});
  const remove = vi.spyOn(api, "worktreeRemove");
  const view = await harness(api);
  view.list().props.onCreate();
  view.of(CreateWorktreeDialog)[0].props.onCreate("demo-xdev", "birch", null);
  view.list().props.onCancelCreate(view.list().props.pending[0].id);
  expect(view.list().props.pending).toEqual([]);
  await tick();
  await tick();
  expect(remove).toHaveBeenCalledWith("/demo/wt/xdev-birch", false, true);
  expect(view.list().props.selected).not.toBe("/demo/wt/xdev-birch");
  expect((await api.workspaceList())[0].worktrees.map((w) => w.name)).not.toContain("birch");
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
  const real = api.workspaceSidebar.bind(api);
  vi.spyOn(api, "workspaceSidebar").mockImplementation(async () =>
    (await real()).map(i => (i.kind === "repo" ? { ...i, repo: { ...i.repo, worktrees: i.repo.worktrees.filter(w => w.path !== "/demo/wt/xdev-oak") } } : i)),
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
  const real = api.workspaceSidebar.bind(api);
  // The repo's folder is unreachable for now, so it comes back with no worktrees.
  vi.spyOn(api, "workspaceSidebar").mockImplementation(async () =>
    (await real()).map(i => (i.kind === "repo" && i.repo.worktrees.some(w => w.path === "/demo/wt/xdev-oak") ? { ...i, repo: { ...i.repo, missing: true, worktrees: [] } } : i)),
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
  const changes = () => tabs()[2];
  // Icon buttons: a name for screen readers and no visible text.
  expect(tabs().map(n => n.props["aria-label"])).toEqual([en("workspace.panel.files"), en("search.files.tab"), en("workspace.panel.changes"), en("checks.tab"), en("issues.tab")]);
  expect(tabs().every(n => n.props.role === "tab" && n.type === "button")).toBe(true);
  expect(renderToStaticMarkup(files())).not.toContain("ws-panel-badge");
  // Files is the default tab, and the tree and the changes list are both mounted.
  expect(tabs().map(n => n.props["aria-selected"])).toEqual([true, false, false, false, false]);
  const panels = () => view.all().filter(n => n.props.role === "tabpanel");
  expect(panels().map(n => n.props.hidden)).toEqual([false, true, true, true, true]);
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
  expect(tabs().map(n => n.props["aria-selected"])).toEqual([false, false, true, false, false]);
  expect(panels().map(n => n.props.hidden)).toEqual([true, true, false, true, true]);
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

it("a create with extras opens the picked agent, keeps it as the default and saves the details once", async () => {
  const api = createMockApi({});
  await api.profilesDefaults("ask", "codex", null);
  const details = vi.spyOn(api, "worktreeDetails");
  const view = await harness(api);
  view.list().props.onCreate();
  await tick();
  view.draw();
  view.of(CreateWorktreeDialog)[0].props.onCreate("demo-xdev", "rocket-birch", null, {
    title: "🚀 birch",
    agent: "claude",
    setDefault: true,
    parent: null,
    item: { kind: "issue", url: "https://x.test/i/7", title: null },
  });
  await tick();
  await tick();
  await tick();
  const sessions = view.of(WorktreeTabs)[0].props.sessions as Sessions;
  expect(sessions.tabs("/demo/wt/xdev-rocket-birch").map(t => t.profileId)).toEqual(["claude"]);
  expect((await api.profiles()).defaultAgent).toBe("claude");
  expect(details).toHaveBeenCalledTimes(1);
  expect(details.mock.calls[0][1]).toEqual({ title: "🚀 birch", item: { kind: "issue", url: "https://x.test/i/7", title: null } });
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

// Runs the effects after the first two (the store and the list are up already) against a stubbed
// window and document; hands back a way to fire their listeners.
function attend(view: Awaited<ReturnType<typeof harness>>) {
  const on = new Map<string, Set<(e: unknown) => void>>();
  const target = {
    addEventListener: (type: string, fn: (e: unknown) => void) => void (on.get(type) ?? on.set(type, new Set()).get(type)!).add(fn),
    removeEventListener: (type: string, fn: (e: unknown) => void) => void on.get(type)?.delete(fn),
  };
  vi.stubGlobal("window", target);
  vi.stubGlobal("document", { ...target, visibilityState: "visible", hasFocus: () => true, querySelector: () => null, querySelectorAll: () => [] });
  hooks.effects = [];
  view.draw();
  for (const effect of hooks.effects.slice(2)) {
    const cleanup = effect();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  }
  const fire = (type: string, event: unknown = {}) => [...(on.get(type) ?? [])].forEach((fn) => fn(event));
  const sessions = view.of(WorktreeTabs)[0].props.sessions as Sessions;
  // An agent tab with hooks in a worktree that is not on screen.
  const tab = sessions.open(OAK, "claude");
  sessions.noteStarted(tab.id, { id: tab.id, pid: 1, program: "agent", agent: true, profile: "claude", permissions: "ask", account: null, accountSource: null, hooks: true, hookEvents: ["prompt", "needs-input", "resume", "turn-failed", "turn-done"], cli: "claude" });
  return { fire, sessions, tab };
}
const OAK = "/demo/wt/xdev-oak";
// Effects run by `attend`; undone after each test so no timer or listener reaches the next one.
const cleanups: (() => void)[] = [];
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
const bell = (view: Awaited<ReturnType<typeof harness>>) => nodes(view.all().find(n => n.type === "header")!.props.children).find(n => n.type === "button" && n.props["aria-haspopup"] === "menu")!;

it("hidden worktree asking a question raises everything", async () => {
  const api = createMockApi({});
  const notify = vi.spyOn(api, "statusNotify");
  const view = await harness(api);
  const { tab } = attend(view);
  expect(bell(view).props["aria-label"]).toBe(en("workspace.header.notifications"));

  api.__hook(tab.id, "needs-input");
  await settle();
  // The row: glyph and bold name.
  expect(view.list().props.dots[OAK]).toBe("needs-you");
  expect(view.list().props.unread[OAK]).toBe(true);
  // The bell counts it; the footer says one waits.
  expect(bell(view).props["aria-label"]).toBe(en("status.bell.label", { count: 1 }));
  expect(nodes(bell(view).props.children).find(n => n.props.className === "ws-bell-count")!.props.children).toBe("1");
  expect(view.of(LiveWorkspaceFooter)[0].props.waiting).toBe(1);
  // The OS hears the worktree and the tab, and the sound goes with it.
  expect(notify).toHaveBeenCalledWith("oak · Claude Code · Needs you", "", tab.id);
  expect(sound.play).toHaveBeenCalledTimes(1);

  // The bell lists the tab; its row goes there.
  expect(view.of(BellMenu)).toHaveLength(0);
  bell(view).props.onClick();
  const menu = view.of(BellMenu)[0];
  expect(menu.props.rows.map((r: { tab: { id: string }; worktree: string }) => [r.tab.id, r.worktree])).toEqual([[tab.id, "oak"]]);
  menu.props.onJump(tab);
  expect(view.list().props.selected).toBe(OAK);
  expect(view.of(WorktreeTabs).find(n => n.props.worktree === OAK)!.props.front).toMatchObject({ id: tab.id });
  expect(view.of(BellMenu)).toHaveLength(0);
});

it("a click on the notification, or a focus soon after it, goes to its pane", async () => {
  const api = createMockApi({});
  const view = await harness(api);
  const { fire, tab } = attend(view);
  api.__hook(tab.id, "needs-input");
  await settle();
  expect(api.__notifications.map(n => n.ptyId)).toEqual([tab.id]);

  // The person clicked in the app first: the next focus is their own.
  fire("pointerdown");
  fire("focus");
  expect(view.list().props.selected).toBe("/demo/xdev");

  // A click that reaches the app goes there.
  api.__clickNotification(tab.id);
  expect(view.list().props.selected).toBe(OAK);
});

it("a focus soon after a notification goes to its pane", async () => {
  const api = createMockApi({});
  const view = await harness(api);
  const { fire, tab } = attend(view);
  api.__hook(tab.id, "needs-input");
  await settle();
  fire("focus");
  expect(view.list().props.selected).toBe(OAK);
});

it("the bell and the sound follow the settings", async () => {
  const api = createMockApi({});
  const notify = vi.spyOn(api, "statusNotify");
  const stored = await api.statusSettings();
  await api.statusSettingsPut({ ...stored, bell: false, sound: false });
  const view = await harness(api);
  const { tab } = attend(view);
  await settle();
  api.__hook(tab.id, "needs-input");
  await settle();
  expect(notify).toHaveBeenCalledTimes(1);
  expect(sound.play).not.toHaveBeenCalled();
  // The bell is off: no count and no list, but the row still says it.
  expect(bell(view).props.disabled).toBe(true);
  expect(bell(view).props.title).toBe(en("status.bell.off"));
  expect(nodes(bell(view).props.children).some(n => n.props.className === "ws-bell-count")).toBe(false);
  expect(view.list().props.unread[OAK]).toBe(true);
});

// Draws again and runs the effects that follow state (the badge among them), then waits out the debounce.
async function rerun(view: Awaited<ReturnType<typeof harness>>) {
  hooks.effects = [];
  view.draw();
  for (const effect of hooks.effects.slice(2)) {
    const cleanup = effect();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  }
  await new Promise((r) => setTimeout(r, BADGE_DEBOUNCE_MS + 50));
}

it("the badge counts worktrees with something unread, not tabs", async () => {
  const api = createMockApi({});
  const view = await harness(api);
  const { sessions, tab } = attend(view);
  const second = sessions.open(OAK, "claude");
  sessions.noteStarted(second.id, { id: second.id, pid: 2, program: "agent", agent: true, profile: "claude", permissions: "ask", account: null, accountSource: null, hooks: true, hookEvents: ["prompt", "needs-input", "resume", "turn-failed", "turn-done"], cli: "claude" });
  api.__hook(tab.id, "needs-input");
  api.__hook(second.id, "needs-input");
  await settle();
  await rerun(view);
  expect(api.__badge()).toBe(1);
  // Marking the worktree read clears it.
  sessions.markRead(OAK);
  await rerun(view);
  expect(api.__badge()).toBe(0);
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

// ---- Worktree keys ----

it("ctrl+shift+down walks the worktrees in sidebar order and wraps", async () => {
  vi.stubGlobal("localStorage", storage());
  const view = await harness();
  const order = reposOf(view.list()).flatMap((r: { worktrees: WorktreeView[] }) => r.worktrees.map((w) => w.path)) as string[];
  expect(order.length).toBeGreaterThan(1);
  view.list().props.onOrder(order);
  view.draw();
  view.list().props.onSelect(view.worktree(order[order.length - 1].split("/").pop()!.replace("xdev-", "")));
  view.draw();
  expect(view.list().props.selected).toBe(order[order.length - 1]);
  expect(keymap.handlers["worktree.next"]()).toBe(true);
  view.draw();
  expect(view.list().props.selected).toBe(order[0]);
  expect(keymap.handlers["worktree.prev"]()).toBe(true);
  view.draw();
  expect(view.list().props.selected).toBe(order[order.length - 1]);
});

it("ctrl+3 picks the third worktree the sidebar shows, and a missing one lets the key on", async () => {
  vi.stubGlobal("localStorage", storage());
  const view = await harness();
  const all = reposOf(view.list()).flatMap((r: { worktrees: WorktreeView[] }) => r.worktrees.map((w) => w.path)) as string[];
  // A collapsed group is not in the order the list reports.
  const shown = [all[0], all[2], all[1]];
  view.list().props.onOrder(shown);
  view.draw();
  expect(keymap.handlers["worktree.select.3"]()).toBe(true);
  view.draw();
  expect(view.list().props.selected).toBe(all[1]);
  expect(keymap.handlers["worktree.select.4"]()).toBe(false);
});

it("worktree keys do nothing with no worktrees, and only while the workspace view shows", async () => {
  vi.stubGlobal("localStorage", storage());
  const view = await harness();
  view.draw();
  expect(keymap.handlers["worktree.next"]()).toBe(false);
  expect(keymap.handlers["worktree.select.1"]()).toBe(false);
  expect(keymap.when()).toBe(true);
  view.nav(en("workspace.nav.docs")).props.onClick();
  view.draw();
  expect(keymap.when()).toBe(false);
});

// ---- Setup after create -----------------------------------------------------------------------

async function created(files: Record<string, unknown>, patch: Record<string, unknown> = {}) {
  const api = createMockApi({}, { workspace: { ...structuredClone(DEMO_WORKSPACE), repoFiles: { "/demo/xdev": files } } as never });
  if (Object.keys(patch).length) await api.repoUpdate("demo-xdev", patch);
  const open = vi.spyOn(Sessions.prototype, "open");
  const view = await harness(api);
  view.list().props.onCreate();
  view.of(CreateWorktreeDialog)[0].props.onCreate("demo-xdev", "birch", null);
  await tick();
  await tick();
  const setupOpens = () => open.mock.calls.filter((c) => c[1] === SETUP_PROFILE);
  return { ...view, open, setupOpens, card: () => view.of(SetupCard)[0], trust: () => view.of(TrustDialog)[0] };
}

it("setup after create: policy Run with a trusted script opens the Setup tab", async () => {
  const rename = vi.spyOn(Sessions.prototype, "rename");
  const v = await created({}, { setupPolicy: "run", localSetup: "pnpm i" });
  expect(v.setupOpens()).toHaveLength(1);
  expect(v.setupOpens()[0][0]).toBe("/demo/wt/xdev-birch");
  expect(rename).toHaveBeenCalledWith(expect.any(String), en("setup.tab"));
  expect(v.card()).toBeUndefined();
});

it("setup after create: policy Skip never opens the Setup tab", async () => {
  const v = await created({}, { setupPolicy: "skip", localSetup: "pnpm i" });
  expect(v.setupOpens()).toHaveLength(0);
  expect(v.card()).toBeUndefined();
  expect(v.trust()).toBeUndefined();
});

it("setup after create: policy Ask shows the card; Run setup opens the tab, Skip does not", async () => {
  const v = await created({}, { localSetup: "pnpm i" });
  expect(v.card().props.state).toEqual({ kind: "ask" });
  expect(v.setupOpens()).toHaveLength(0);
  v.card().props.onSkip();
  expect(v.card()).toBeUndefined();

  const w = await created({}, { localSetup: "pnpm i" });
  w.card().props.onRun();
  await tick();
  expect(w.setupOpens()).toHaveLength(1);
  expect(w.card()).toBeUndefined();
});

it("setup after create: Always run stores policy Run and runs", async () => {
  const v = await created({}, { localSetup: "pnpm i" });
  const update = vi.spyOn(v.api, "repoUpdate");
  v.card().props.onAlways();
  await tick();
  expect(update).toHaveBeenCalledWith("demo-xdev", { setupPolicy: "run" });
  expect(v.setupOpens()).toHaveLength(1);
});

it("setup after create: a detected command can be saved as local setup", async () => {
  const v = await created({ detected: "pnpm install" });
  expect(v.card().props.state).toEqual({ kind: "detected", command: "pnpm install" });
  const update = vi.spyOn(v.api, "repoUpdate");
  v.card().props.onSave();
  await tick();
  expect(update).toHaveBeenCalledWith("demo-xdev", { localSetup: "pnpm install" });
  expect(v.card()).toBeUndefined();
});

it("setup after create: an untrusted shared script shows its text; Trust runs it", async () => {
  const v = await created({ setup: "curl x | sh" }, { setupPolicy: "run" });
  expect(v.setupOpens()).toHaveLength(0);
  expect(v.trust().props.text).toBe("curl x | sh");
  expect(v.trust().props.changed).toBe(false);
  v.trust().props.onTrust();
  await tick();
  expect(v.setupOpens()).toHaveLength(1);
  expect(v.trust()).toBeUndefined();
});

it("link report: a toast lists shared paths that did not link, with the error; all linked says nothing", async () => {
  const api = createMockApi({}, { workspace: { ...structuredClone(DEMO_WORKSPACE), repoFiles: { "/demo/xdev": { shared: ["node_modules", ".env.local"], linkErrors: { ".env.local": "missing in the main checkout" } } } } as never });
  const view = await harness(api);
  // Trust the list first so the next create links it.
  const primary = DEMO_WORKSPACE.repos[0].worktrees[0].path;
  await api.repoHookTrust(primary, "shared", (await api.repoHooks(primary)).sharedHash!);
  view.list().props.onCreate();
  view.of(CreateWorktreeDialog)[0].props.onCreate("demo-xdev", "birch", null);
  await tick();
  await tick();
  const texts = getToasts().map((x) => x.text);
  expect(texts).toHaveLength(1);
  expect(texts[0]).toContain(".env.local: missing in the main checkout");
  expect(texts[0]).not.toContain("node_modules");
  for (const x of getToasts()) dismissToast(x.id);
});

it("link report: nothing to say when the list is not trusted", async () => {
  const api = createMockApi({}, { workspace: { ...structuredClone(DEMO_WORKSPACE), repoFiles: { "/demo/xdev": { shared: ["node_modules"] } } } as never });
  const before = getToasts().length;
  const view = await harness(api);
  view.list().props.onCreate();
  view.of(CreateWorktreeDialog)[0].props.onCreate("demo-xdev", "birch", null);
  await tick();
  await tick();
  expect(getToasts().filter((x) => x.text.includes("node_modules"))).toHaveLength(0);
  expect(getToasts().length).toBe(before);
});

const LISTS = { shared: ["node_modules", ".env.local"], tabs: [{ title: "dev", color: "#4a9", command: "pnpm dev" }] };

it("repo file lists: untrusted shared paths and tabs are asked about, and Trust writes each hash", async () => {
  const v = await created(LISTS, { setupPolicy: "skip" });
  expect(v.trust().props).toMatchObject({ kind: "lists", text: "", shared: LISTS.shared, tabs: LISTS.tabs });
  const trust = vi.spyOn(v.api, "repoHookTrust");
  v.trust().props.onTrust();
  await tick();
  expect(trust.mock.calls.map((c) => c[1])).toEqual(["shared", "tabs"]);
  expect(v.trust()).toBeUndefined();
});

it("repo file lists: with an untrusted setup script one prompt covers the script and the lists", async () => {
  const v = await created({ ...LISTS, setup: "pnpm i" }, { setupPolicy: "run" });
  expect(v.trust().props).toMatchObject({ kind: "setup", text: "pnpm i", shared: LISTS.shared, tabs: LISTS.tabs });
  const trust = vi.spyOn(v.api, "repoHookTrust");
  v.trust().props.onTrust();
  await tick();
  expect(trust.mock.calls.map((c) => c[1])).toEqual(["shared", "tabs", "setup"]);
  expect(v.setupOpens()).toHaveLength(1);
});

it("repo file lists: Cancel leaves them untrusted and the setup card still shows", async () => {
  const v = await created(LISTS, { localSetup: "pnpm i" });
  expect(v.trust().props.kind).toBe("lists");
  v.trust().props.onCancel();
  await tick();
  expect(v.trust()).toBeUndefined();
  expect(v.card().props.state).toEqual({ kind: "ask" });
  expect((await v.api.repoHooks("/demo/wt/xdev-birch")).sharedTrusted).toBe(false);
});

const TABS = { tabs: [{ title: "dev", color: "#4a9", command: "pnpm dev" }, { title: "tests", color: null, command: "cargo watch" }] };

it("default tabs: with no setup, trusting the list opens one shell tab per entry", async () => {
  const rename = vi.spyOn(Sessions.prototype, "rename");
  const v = await created(TABS, { setupPolicy: "skip" });
  expect(v.trust().props.kind).toBe("lists");
  v.trust().props.onTrust();
  await tick();
  await tick();
  const shells = v.open.mock.calls.filter((c) => String(c[1]).startsWith("shell"));
  expect(shells).toHaveLength(2);
  expect(rename.mock.calls.map((c) => c[1])).toEqual(["dev", "tests"]);
});

it("default tabs: untrusted tabs open nothing", async () => {
  const v = await created(TABS, { setupPolicy: "skip" });
  v.trust().props.onCancel();
  await tick();
  expect(v.open.mock.calls.filter((c) => String(c[1]).startsWith("shell"))).toHaveLength(0);
});

it("default tabs: they wait for the setup tab; a failed setup opens none and the card offers them", async () => {
  const v = await created({ ...TABS, setup: "pnpm i", setupCode: 1 }, { setupPolicy: "run" });
  v.trust().props.onTrust();
  await tick();
  await tick();
  expect(v.setupOpens()).toHaveLength(1);
  const shells = () => v.open.mock.calls.filter((c) => String(c[1]).startsWith("shell"));
  expect(shells()).toHaveLength(0);
  // The setup tab exits with code 1, as the pty event would say it.
  const at = v.open.mock.calls.findIndex((c) => c[1] === SETUP_PROFILE);
  const tab = v.open.mock.results[at].value as { id: string };
  (v.open.mock.instances[at] as unknown as { apply(id: string, e: { kind: "exit"; code: number }): void }).apply(tab.id, { kind: "exit", code: 1 });
  expect(v.card()?.props.state).toMatchObject({ kind: "failed", tabs: true });
  v.card().props.onOpenTabs();
  await tick();
  await tick();
  expect(shells()).toHaveLength(2);
});

it("setup after create: a stale hash reopens the prompt with the new text", async () => {
  const v = await created({ setup: "old" }, { setupPolicy: "run" });
  vi.spyOn(v.api, "repoHookTrust").mockRejectedValueOnce({ code: "hook_untrusted" });
  vi.spyOn(v.api, "repoHooks").mockResolvedValueOnce({ setup: { text: "new", shared: true, hash: "n", trusted: false }, archive: null, waitForSetup: false, policy: "run", parseError: null, detected: null, shared: [], sharedTrusted: false, tabs: [], tabsTrusted: false, sharedHash: null, tabsHash: null, unknown: [], problems: [] });
  v.trust().props.onTrust();
  await tick();
  expect(v.setupOpens()).toHaveLength(0);
  expect(v.trust().props.text).toBe("new");
  expect(v.trust().props.changed).toBe(true);
});

it("setup after create: with wait, the default agent starts after setup exits", async () => {
  const v = await created({ waitForSetup: true }, { setupPolicy: "run", localSetup: "pnpm i" });
  expect(v.setupOpens()).toHaveLength(1);
  expect(v.open.mock.calls.filter((c) => c[1] !== SETUP_PROFILE)).toHaveLength(0);
  expect(v.card().props.state).toEqual({ kind: "waiting" });
  v.card().props.onStartNow();
  expect(v.open.mock.calls.filter((c) => c[1] !== SETUP_PROFILE).length).toBeGreaterThan(0);
});

it("askBeforeDeleteWorktree off removes at once with the dialog's defaults; a dirty worktree still asks", async () => {
  setNavigationSettings({ ...NAVIGATION_DEFAULTS, askBeforeDeleteWorktree: false });
  const close = vi.spyOn(Sessions.prototype, "closeWorktree");
  const api = createMockApi({});
  const remove = vi.spyOn(api, "worktreeRemove");
  const view = await harness(api);
  const dialog = () => view.of(RemoveWorktreeDialog)[0];

  // A clean worktree goes without a dialog at any point.
  view.list().props.onRemove(view.worktree("elm"));
  expect(view.of(RemoveWorktreeDialog)).toHaveLength(0);
  await tick();
  expect(close).toHaveBeenCalledWith("/demo/wt/xdev-elm");
  expect(remove).toHaveBeenCalledWith("/demo/wt/xdev-elm", false, true);
  expect(view.of(RemoveWorktreeDialog)).toHaveLength(0);
  expect(view.worktree("elm")).toBeUndefined();

  // Uncommitted work: the removal is refused, and the forced delete needs its own yes.
  view.list().props.onRemove(view.worktree("oak"));
  await tick();
  expect(remove).toHaveBeenLastCalledWith("/demo/wt/xdev-oak", false, true);
  expect(dialog().props.dirty).toBe(true);
  expect(view.worktree("oak")).toBeDefined();
});

// ---- Archive before delete ---------------------------------------------------------------------

async function removal(files: Record<string, unknown>, patch: Record<string, unknown> = {}) {
  const api = createMockApi({}, { workspace: { ...structuredClone(DEMO_WORKSPACE), repoFiles: { "/demo/xdev": files } } as never });
  if (Object.keys(patch).length) await api.repoUpdate("demo-xdev", patch);
  const archive = vi.spyOn(api, "worktreeArchiveRun");
  const remove = vi.spyOn(api, "worktreeRemove");
  const view = await harness(api);
  view.list().props.onRemove(view.worktree("oak"));
  return { ...view, archive, remove, dialog: () => view.of(RemoveWorktreeDialog)[0], trust: () => view.of(TrustDialog)[0] };
}

it("delete: no archive script removes at once", async () => {
  const v = await removal({});
  v.dialog().props.onConfirm();
  await tick();
  expect(v.archive).toHaveBeenCalledWith("/demo/wt/xdev-oak");
  expect(v.remove).toHaveBeenCalledOnce();
});

it("delete: the archive runs first, with a spinner line and Cancel usable", async () => {
  const v = await removal({}, { localArchive: "echo bye" });
  let finish!: (r: { ran: boolean; code: number; output: string }) => void;
  v.archive.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  v.dialog().props.onConfirm();
  expect(v.dialog().props.archiving).toBe(true);
  const markup = renderToStaticMarkup(v.dialog());
  expect(markup).toContain(en("workspace.remove.archiving"));
  expect(markup).toMatch(/<button[^>]*autofocus[^>]*>/i);
  expect(markup).not.toMatch(/<button[^>]*disabled[^>]*>\s*Cancel/);
  // Cancel during the run closes the dialog; the late result removes nothing.
  v.dialog().props.onCancel();
  finish({ ran: true, code: 0, output: "" });
  await tick();
  expect(v.remove).not.toHaveBeenCalled();
});

it("delete: a failing archive script shows its output and asks", async () => {
  const v = await removal({ archiveCode: 2, archiveOutput: "boom" }, { localArchive: "exit 2" });
  v.dialog().props.onConfirm();
  await tick();
  expect(v.remove).not.toHaveBeenCalled();
  expect(v.dialog().props.failed).toEqual({ code: 2, output: "boom" });
  const markup = renderToStaticMarkup(v.dialog());
  expect(markup).toContain("boom");
  expect(markup).toContain(en("workspace.remove.anyway"));
  v.dialog().props.onConfirm();
  await tick();
  expect(v.archive).toHaveBeenCalledOnce();
  expect(v.remove).toHaveBeenCalledOnce();
});

it("delete: an untrusted archive script shows the trust prompt, then removes", async () => {
  const v = await removal({ archive: "echo bye" });
  v.dialog().props.onConfirm();
  await tick();
  expect(v.remove).not.toHaveBeenCalled();
  expect(v.trust().props.kind).toBe("archive");
  expect(v.trust().props.text).toBe("echo bye");
  v.trust().props.onTrust();
  await tick();
  await tick();
  expect(v.trust()).toBeUndefined();
  expect(v.remove).toHaveBeenCalledOnce();
});

// ---- Global keys ----

it("sessions.open shows the sessions view with the search box asked for focus", async () => {
  const view = await harness();
  view.nav(en("workspace.nav.docs")).props.onClick();
  view.draw();
  const before = view.of(SessionsSidebar)[0]?.props.focusSeq;
  expect(keymap.handlers["sessions.open"]()).not.toBe(false);
  view.draw();
  const side = view.of(SessionsSidebar)[0];
  expect(side.props.visible).toBe(true);
  expect(side.props.focusSeq).toBeGreaterThan(before ?? 0);
  expect(keymap.when()).toBe(true);
});

it("the toast host is mounted, and its Open Shortcuts button opens that page filtered to the action", async () => {
  const view = await harness();
  expect(view.of(Toasts)).toHaveLength(1);
  view.draw();
  // Every effect of a render; the one that registers the terminal key host is among them.
  for (const effect of hooks.effects.slice(2)) {
    try { effect(); } catch { /* the others need a window */ }
  }
  expect(termKey.host).not.toBeNull();
  termKey.host!.openShortcuts("panel.sourceControl");
  view.draw();
  const settings = view.of(SettingsView)[0];
  expect(settings.props.initial).toBe("keys");
  expect(settings.props.arg).toBe("panel.sourceControl");
});

it("sidebar and panel keys toggle the left sidebar and the right panel", async () => {
  const view = await harness();
  const region = (cls: string) => view.all().find((n) => n.props.className === cls)!;
  expect(region("ws-sidebar").props.hidden).toBe(false);
  keymap.handlers["sidebar.left.toggle"]();
  view.draw();
  expect(region("ws-sidebar").props.hidden).toBe(true);
  expect(region("ws-panel").props.hidden).toBe(false);
  keymap.handlers["sidebar.right.toggle"]();
  view.draw();
  expect(region("ws-panel").props.hidden).toBe(true);
  // A panel key reopens it on its tab; pressed again on that tab it closes.
  keymap.handlers["panel.sourceControl"]();
  view.draw();
  expect(region("ws-panel").props.hidden).toBe(false);
  keymap.handlers["panel.sourceControl"]();
  view.draw();
  expect(region("ws-panel").props.hidden).toBe(true);
  keymap.handlers["panel.explorer"]();
  view.draw();
  expect(region("ws-panel").props.hidden).toBe(false);
});

it("settings and search keys open their views", async () => {
  const view = await harness();
  keymap.handlers["settings.shortcuts"]();
  view.draw();
  expect(view.of(SettingsView)[0].props.initial).toBe("keys");
  keymap.handlers["search.open"]();
  view.draw();
  expect(view.of(DocsApp)).toHaveLength(1);
});

it("Manage accounts in the usage popover shows the docs view on the Accounts app", async () => {
  const view = await harness();
  expect(view.of(LiveWorkspaceFooter)[0].props.onManageAccounts).toBeTypeOf("function");
  expect(view.of(DocsApp)).toHaveLength(0);
  view.of(LiveWorkspaceFooter)[0].props.onManageAccounts();
  view.draw();
  expect(view.of(DocsApp)[0].props.appRequest).toEqual({ app: "accounts", seq: 1 });
  expect(view.all().find(n => n.props.className === "ws-docs")!.props.hidden).toBe(false);
  // Asking again is a new request, so Accounts shows again after the person moved elsewhere.
  view.of(LiveWorkspaceFooter)[0].props.onManageAccounts();
  view.draw();
  expect(view.of(DocsApp)[0].props.appRequest).toEqual({ app: "accounts", seq: 2 });
});

it("Usage details in the usage popover opens the Stats & Usage settings section", async () => {
  const view = await harness();
  view.of(LiveWorkspaceFooter)[0].props.onOpenUsage();
  view.draw();
  expect(view.of(SettingsView)[0].props.initial).toBe("usage");
});

// Ctrl+Shift+Backspace, selection and branch review.
const DEL_KEY = { key: "Backspace", ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, target: null, preventDefault() {} };

it("ctrl+shift+backspace opens the delete dialog for the open worktree; two selected open the bulk dialog", async () => {
  const api = createMockApi({});
  const view = await harness(api);
  const { fire } = attend(view);
  view.list().props.onSelect(view.worktree("oak"));
  await settle();
  view.draw();
  fire("keydown", DEL_KEY);
  await settle();
  expect(view.of(RemoveWorktreeDialog)).toHaveLength(1);
  view.of(RemoveWorktreeDialog)[0].props.onCancel();
  await settle();
  // The list reports its visible order when it draws; the stubbed list does not.
  view.list().props.onOrder([OAK, view.worktree("elm").path]);
  await settle();
  view.draw();
  view.list().props.onPick(view.worktree("oak"), { toggle: true, range: false });
  view.list().props.onPick(view.worktree("elm"), { toggle: true, range: false });
  await settle();
  view.draw();
  fire("keydown", DEL_KEY);
  await settle();
  expect(view.of(BulkRemoveDialog)).toHaveLength(1);
});

it("with askBeforeDeleteWorktree off, ctrl+shift+backspace deletes the open worktree without a dialog", async () => {
  setNavigationSettings({ ...NAVIGATION_DEFAULTS, askBeforeDeleteWorktree: false });
  const api = createMockApi({});
  const remove = vi.spyOn(api, "worktreeRemove");
  const view = await harness(api);
  const { fire } = attend(view);
  view.list().props.onSelect(view.worktree("elm"));
  await settle();
  view.draw();
  fire("keydown", DEL_KEY);
  await settle();
  expect(remove).toHaveBeenCalledWith("/demo/wt/xdev-elm", false, true);
  expect(view.of(RemoveWorktreeDialog)).toHaveLength(0);
  expect(view.worktree("elm")).toBeUndefined();
});

it("a delete that kept a branch offers a review", async () => {
  const api = createMockApi({});
  const kept = { repoId: "demo-xdev", branch: "oak", path: "/x", keptMs: 1, reason: "deleted", title: null, comment: "", status: null, item: null };
  vi.spyOn(api, "worktreeRemove").mockResolvedValue({ deletedBranch: null, kept } as never);
  const view = await harness(api);
  view.list().props.onRemove(view.worktree("oak"));
  view.of(RemoveWorktreeDialog)[0].props.onConfirm(false);
  await settle();
  expect(view.of(RemoveWorktreeDialog)).toHaveLength(0);
  expect(getToasts().some((x) => x.text === en("review.notice", { count: 1 }))).toBe(true);
});

it("the issues tab shows the panel of the current repo", async () => {
  const view = await harness();
  view.list().props.onSelect(view.worktree("oak"));
  const tab = () => view.all().find(n => n.props.className === "ws-panel-tab" && n.props["aria-label"] === en("issues.tab"))!;
  const body = () => view.all().find(n => n.props.role === "tabpanel" && nodes(n.props.children).some(c => c.type === IssuesPanel))!;
  expect(body().props.hidden).toBe(true);
  expect(view.of(IssuesPanel)[0].props.repoId).toBe("demo-xdev");
  tab().props.onClick();
  expect(tab().props["aria-selected"]).toBe(true);
  expect(body().props.hidden).toBe(false);
});

it("the issues key opens the tab and closes the panel when pressed again", async () => {
  const view = await harness();
  const panel = () => view.all().find(n => n.props.className === "ws-panel")!;
  const tab = () => view.all().find(n => n.props.className === "ws-panel-tab" && n.props["aria-label"] === en("issues.tab"))!;
  keymap.handlers["panel.issues"]();
  view.draw();
  expect(panel().props.hidden).toBe(false);
  expect(tab().props["aria-selected"]).toBe(true);
  keymap.handlers["panel.issues"]();
  view.draw();
  expect(panel().props.hidden).toBe(true);
});

it("Start worktree on an issue makes a worktree named from it, links the issue and opens the agent", async () => {
  const api = createMockApi({});
  await api.profilesDefaults("ask", "codex", null);
  const details = vi.spyOn(api, "worktreeDetails");
  const view = await harness(api);
  const detail = await api.issueView("demo-xdev", 1);
  view.of(IssuesPanel)[0].props.onStart(detail);
  await settle();
  const path = "/demo/wt/xdev-1-footer-meter-overflows";
  expect(view.list().props.selected).toBe(path);
  const sessions = view.of(WorktreeTabs)[0].props.sessions as Sessions;
  expect(sessions.tabs(path).map(t => t.profileId)).toEqual(["codex"]);
  expect(details).toHaveBeenCalledTimes(1);
  expect(details.mock.calls[0][1]).toEqual({ item: { kind: "issue", url: detail.issue.url, title: detail.issue.title } });
});

it("a second Start worktree on the same issue takes the -2 name", async () => {
  const api = createMockApi({});
  const view = await harness(api);
  const detail = await api.issueView("demo-xdev", 1);
  view.of(IssuesPanel)[0].props.onStart(detail);
  await settle();
  view.of(IssuesPanel)[0].props.onStart(detail);
  await settle();
  expect(view.list().props.selected).toBe("/demo/wt/xdev-1-footer-meter-overflows-2");
});
