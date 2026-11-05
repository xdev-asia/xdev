import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { EmptyState } from "@xdev-asia/ui";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi, toApiError, type Api, type Profile, type ProfilesView, type PtyExit } from "@/api";
import { fileTabs } from "@/files/fileTabs";
import { MarkdownPreview } from "@/files/MarkdownPreview";
import { UnsavedDialog } from "@/files/UnsavedDialog";
import { translate } from "@/i18n";
import { resetNavigationSettingsForTests, setNavigationSettings } from "@/settings/navigationSettings";
import { NAVIGATION_DEFAULTS } from "@/settings/generalDefaults";
import { useKeymap } from "@/keys/keymap";
import { Terminal, type TerminalHandle } from "@/terminal/Terminal";
import { ContextMenu } from "@/ui/ContextMenu";
import { AgentIcon } from "./AgentIcon";
import { CloseTabsDialog } from "./CloseTabsDialog";
import { CommitView } from "./CommitView";
import { Sessions } from "./sessions";
import { addTab, leaves, paneOf, removeTab, resize, selectTab, single, splitPane, toggleExpand, type PaneLayout, type PaneNode } from "./paneTree";
import { PaneView } from "./PaneView";
import { TabStrip } from "./TabStrip";
import { TabTitleDialog } from "./TabTitleDialog";
import { WorktreeTabs } from "./WorktreeTabs";

// Hooks are stubbed only while the tabs component itself is called; each harness keeps its own.
const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0, effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const state = (initial: unknown) => {
    const index = hooks.cursor++;
    const values = hooks.values;
    if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
    return [values[index], (value: unknown) => { values[index] = typeof value === "function" ? value(values[index]) : value; }];
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
vi.mock("@/keys/keymap", async (original) => {
  const real = await original<typeof import("@/keys/keymap")>();
  return { ...real, useKeymap: vi.fn(real.useKeymap) };
});
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));
// The profile view the tabs read; `null` is a store that has not loaded.
const store = vi.hoisted(() => ({ view: null as ProfilesView | null }));
vi.mock("@/agents/profileStore", async (original) => ({
  ...await original<typeof import("@/agents/profileStore")>(),
  useProfiles: () => ({ view: store.view, update() {}, async reload() {} }),
}));
// xterm needs a real canvas; `run` below does what the terminal does with its client.
vi.mock("@/terminal/Terminal", () => ({ Terminal: () => null }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
// The shallow draw leaves PaneView and TabStrip as elements; this calls them (hooks stubbed) so their buttons show.
function expand(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expand);
  if (!value || typeof value !== "object" || !("props" in value)) return value;
  const node = value as Node;
  if (node.type === PaneView || node.type === TabStrip) {
    return { ...node, props: { ...node.props, children: expand((node.type as (p: unknown) => unknown)(node.props)) } };
  }
  return { ...node, props: { ...node.props, children: expand(node.props.children) } };
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const A = "/demo/wt/xdev-oak";
const B = "/demo/wt/xdev-elm";

function harness(api: Api, sessions: Sessions, worktree = A, visible = true, extra: Partial<Parameters<typeof WorktreeTabs>[0]> = {}) {
  const values: unknown[] = [];
  const draw = () => {
    hooks.values = values;
    hooks.cursor = 0;
    hooks.active = true;
    try { return WorktreeTabs({ api, sessions, worktree, visible, ...extra }); } finally { hooks.active = false; }
  };
  const drawFull = () => {
    hooks.values = values;
    hooks.cursor = 0;
    hooks.active = true;
    try { return expand(WorktreeTabs({ api, sessions, worktree, visible, ...extra })); } finally { hooks.active = false; }
  };
  const all = () => nodes(drawFull());
  const html = () => renderToStaticMarkup(draw());
  const find = (pick: (n: Node) => boolean) => all().find(pick);
  const labelled = (label: string) => find((n) => n.props["aria-label"] === label && n.props.onClick)!;
  const button = (text: string) => find((n) => n.type === "button" && n.props.children === text)!;
  const terminals = () => all().filter((n) => n.type === Terminal);
  const dialog = () => find((n) => typeof n.props.onConfirm === "function")!;
  return { draw, drawFull, all, html, find, labelled, button, terminals, dialog };
}

// What the terminal does on mount: start its tab's client, report the outcome.
async function run(term: Node) {
  await term.props.client
    .start(term.props.cwd, term.props.profile, 80, 24, () => {}, term.props.account ?? null)
    .then(term.props.onStarted, (e: unknown) => term.props.onError(toApiError(e)));
}

let sessions: Sessions | null = null;
beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false; store.view = null; resetNavigationSettingsForTests(); });
afterEach(() => { sessions?.dispose(); sessions = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("plus menu starts claude in the worktree after approval", async () => {
  const api = createMockApi({});
  const approve = vi.spyOn(api, "ptyApprove");
  const spawn = vi.spyOn(api, "ptySpawn");
  const live = (sessions = new Sessions(api));
  const view = harness(api, live);
  openMenu(view, live);
  view.find((n) => n.props.role === "menuitem" && n.props.children === en("terminal.profile.claude"))!.props.onClick();
  const tab = live.tabs(A).at(-1)!;
  const mine = () => view.terminals().find((t) => t.props.id === tab.id)!;
  expect(tab).toMatchObject({ worktree: A, profileId: "claude" });
  // The menu closes once something is picked.
  expect(view.find((n) => n.props.role === "menu")).toBeUndefined();

  const first = mine();
  expect(first.props).toMatchObject({ id: tab.id, cwd: A, profile: "claude", client: tab.client });
  await run(first);
  expect(view.dialog().props.open).toBe(true);
  expect(view.dialog().props.body).toContain("start claude in a terminal");

  view.dialog().props.onConfirm();
  await tick();
  expect(approve).toHaveBeenCalledWith("claude", null);
  const second = mine();
  // A fresh view on the same tab and pty id.
  expect(second.key).not.toBe(first.key);
  expect(second.props.client).toBe(tab.client);
  await run(second);
  expect(spawn).toHaveBeenCalledTimes(2);
  expect(spawn.mock.calls[1].slice(0, 3)).toEqual([tab.id, A, "claude"]);
  expect(approve.mock.invocationCallOrder[0]).toBeLessThan(spawn.mock.invocationCallOrder[1]);
  expect(view.dialog().props.open).toBe(false);
  expect(live.tabs(A)).toHaveLength(2);
});

it("tabs of another worktree stay mounted but hidden", async () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const a1 = live.open(A, "shell");
  const a2 = live.open(A, "codex");
  const b1 = live.open(B, "shell");
  const other = harness(api, live, B, false);
  const root = other.all()[0];
  expect(root.props.hidden).toBe(true);
  expect(other.terminals().map((n) => n.props.id)).toEqual([b1.id]);

  const view = harness(api, live, A, true);
  expect(view.all()[0].props.hidden).toBe(false);
  const pane = (id: string) => view.find((n) => n.props.role === "tabpanel" && n.props["data-tab"] === id)!;
  // The newest tab shows; the other stays mounted behind it.
  expect(pane(a2.id).props.hidden).toBe(false);
  expect(pane(a1.id).props.hidden).toBe(true);
  view.find((n) => n.props.role === "tab" && n.props["data-tab"] === a1.id)!.props.onClick();
  expect(pane(a1.id).props.hidden).toBe(false);
  expect(pane(a2.id).props.hidden).toBe(true);
  expect(view.terminals().map((n) => n.props.id)).toEqual([a1.id, a2.id]);
});

it("closing a tab kills its pty", async () => {
  const api = createMockApi({});
  const kill = vi.spyOn(api, "ptyKill");
  const live = (sessions = new Sessions(api));
  const view = harness(api, live);
  const empty = view.html();
  expect(empty).toContain(en("workspace.tabs.empty"));
  for (const p of ["shell", "claude", "codex"]) expect(empty).toContain(en(`terminal.profile.${p}`));

  view.button(en("terminal.profile.shell")).props.onClick();
  const [tab] = live.tabs(A);
  await run(view.terminals()[0]);
  // A plain shell has no status, so no glyph.
  expect(view.html()).not.toContain("ws-glyph");
  view.labelled(en("workspace.tabs.close", { name: en("terminal.profile.shell") })).props.onClick();
  await tick();
  expect(kill).toHaveBeenCalledWith(tab.id);
  expect(live.tabs(A)).toEqual([]);
  expect(view.terminals()).toHaveLength(0);
  expect(view.html()).toContain(en("workspace.tabs.empty"));
});

it("exited tab offers start again", async () => {
  const api = createMockApi({});
  let fire: (e: PtyExit) => void = () => {};
  vi.spyOn(api, "onPtyExit").mockImplementation(async (cb) => ((fire = cb), () => {}));
  const spawn = vi.spyOn(api, "ptySpawn");
  const live = (sessions = new Sessions(api));
  const view = harness(api, live);
  const tab = live.open(A, "shell");
  await run(view.terminals()[0]);
  expect(view.html()).not.toContain(en("workspace.tabs.again"));

  fire({ id: tab.id, code: 1 });
  const html = view.html();
  expect(html).toContain("Exited (code 1)");
  expect(html).not.toContain("ws-glyph");

  view.button(en("workspace.tabs.again")).props.onClick();
  const [again] = live.tabs(A);
  expect(again.id).not.toBe(tab.id);
  expect(again.profileId).toBe("shell");
  const term = view.terminals()[0];
  expect(term.props.id).toBe(again.id);
  await run(term);
  expect(spawn).toHaveBeenCalledTimes(2);
  expect(spawn.mock.calls[1].slice(0, 3)).toEqual([again.id, A, "shell"]);
  expect(view.html()).not.toContain("Exited (code 1)");
});

const pickTab = (view: ReturnType<typeof harness>, id: string) => view.find((n) => n.props.role === "tab" && n.props["data-tab"] === id)!.props.onClick();

it("shows the agent icon and status glyph on each tab", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  live.open(A, "claude");
  live.open(A, "codex");
  live.open(A, "shell");
  const view = harness(api, live);
  const tabs = view.all().filter((n) => n.props.role === "tab");
  expect(tabs).toHaveLength(3);
  for (const [i, profile] of (["claude", "codex", "shell"] as const).entries()) {
    const inside = nodes(tabs[i].props.children);
    // The mark and the status glyph sit in the same tab button.
    expect(inside.find((n) => n.type === AgentIcon)!.props.profile).toBe(profile);
    const glyph = inside.find((n) => n.props.role === "img");
    if (profile === "shell") {
      // A plain shell has no status to show.
      expect(glyph).toBeUndefined();
    } else {
      expect(glyph!.props["aria-label"]).toBe(en("workspace.tabs.status.idle"));
      expect(glyph!.props["data-status"]).toBe("idle");
    }
  }
  const html = view.html();
  // The mark is decoration: the name next to it says the same.
  expect(html).toContain('class="ws-agent" data-profile="claude"');
  for (const letter of ["C", "X", "S"]) expect(html).toContain(`>${letter}</span>`);
  expect(html.split('class="ws-glyph"')).toHaveLength(3);
  // No colored stripe: the glyph carries the state.
  expect(html).not.toContain("ws-stripe");
});

it("an unread done tab is bold and says so", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const tab = live.open(A, "claude");
  Object.assign(tab, { status: "done", unread: true });
  const view = harness(api, live);
  const button = view.find((n) => n.props.role === "tab" && n.props["data-tab"] === tab.id)!;
  expect(button.props.className).toBe("ws-tab-main ws-tab-unread");
  const name = en("terminal.profile.claude");
  expect(button.props["aria-label"]).toBe(`${name}, done, unread`);
  const vi_ = (key: string, vars?: Record<string, string>) => translate("vi", key, vars);
  expect(vi_("workspace.tabs.unreadLabel", { name, status: vi_("workspace.tabs.status.done").toLocaleLowerCase() })).toBe(
    `${name}, xong, chưa xem`,
  );
  const glyph = nodes(button.props.children).find((n) => n.props.role === "img")!;
  expect(glyph.props["data-status"]).toBe("done");
  expect(view.html()).toContain(">✓</span>");
});

// A layout of three tabs: one pane at the left, two stacked at the right.
function threePanes(live: Sessions) {
  const one = live.open(A, "shell");
  const two = live.open(A, "claude");
  const three = live.open(A, "codex");
  let l = live.layout(A)!;
  l = removeTab(l, two.id)!;
  l = removeTab(l, three.id)!;
  l = splitPane(l, l.focused, "right", two.id);
  l = splitPane(l, l.focused, "down", three.id);
  live.setLayout(A, l);
  return { one, two, three };
}
const leafOf = (l: PaneLayout, id: string) => leaves(l).find((n) => n.id === id) as Extract<PaneNode, { kind: "leaf" }>;
const panesOf = (view: ReturnType<typeof harness>) => view.all().filter((n) => n.props.className === "ws-pane");
const shownIds = (view: ReturnType<typeof harness>) =>
  view.all().filter((n) => n.props.role === "tabpanel" && !n.props.hidden).map((n) => n.props["data-tab"]);

// What decides whether React remounts a terminal: its key, and the keys and types of everything above it.
function mountPaths(view: ReturnType<typeof harness>): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (value: unknown, path: string[]): void => {
    if (Array.isArray(value)) return value.forEach((v) => walk(v, path));
    if (!value || typeof value !== "object" || !("props" in value)) return;
    const node = value as Node;
    const here = [...path, `${typeof node.type === "string" ? node.type : "C"}#${node.key ?? ""}`];
    if (node.type === Terminal) out[node.props.id] = here.join("/");
    walk(node.props.children, here);
  };
  walk(view.drawFull(), []);
  return out;
}

it("a two-level layout renders three panes, each with its own strip and terminal", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const { one, two, three } = threePanes(live);
  const view = harness(api, live);
  expect(panesOf(view)).toHaveLength(3);
  expect(view.all().filter((n) => n.type === TabStrip)).toHaveLength(3);
  expect(shownIds(view)).toEqual([one.id, two.id, three.id]);
  // The terminals are one flat list, each placed by an inline rect.
  const rects = view.all().filter((n) => n.props.role === "tabpanel").map((n) => n.props.style);
  expect(rects[0]).toMatchObject({ left: "0%", width: "50%" });
  expect(rects[1]).toMatchObject({ left: "50%", width: "50%" });
  expect(rects[2]).toMatchObject({ left: "50%", width: "50%" });
  expect(view.find((n) => n.props.className === "ws-pane-tree")).toBeDefined();
  // The old right / down toggle buttons are gone; the split items live in the `+` menu.
  expect(view.find((n) => n.props["aria-pressed"] !== undefined)).toBeUndefined();
});

it("clicking a pane focuses it", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const { one, three } = threePanes(live);
  const view = harness(api, live);
  expect(live.layout(A)!.focused).toBe(paneOf(live.layout(A)!, three.id));
  const target = panesOf(view).find((n) => n.props["data-pane"] === paneOf(live.layout(A)!, one.id))!;
  expect(target.props["data-focused"]).toBe(false);
  target.props.onPointerDown();
  expect(live.layout(A)!.focused).toBe(paneOf(live.layout(A)!, one.id));
  expect(panesOf(view).filter((n) => n.props["data-focused"] === true)).toHaveLength(1);
  // Pressing inside a terminal focuses its pane too.
  view.find((n) => n.props.role === "tabpanel" && n.props["data-tab"] === three.id)!.props.onPointerDownCapture();
  expect(live.layout(A)!.focused).toBe(paneOf(live.layout(A)!, three.id));
});

it("dragging a handle changes the sizes, double click evens them out", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  threePanes(live);
  const view = harness(api, live);
  const root = live.layout(A)!.root as Extract<PaneNode, { kind: "split" }>;
  // The root split is vertical (children side by side); the inner split's handle comes first in the tree.
  const handle = () => view.all().find((n) => n.props.role === "separator" && n.props["aria-orientation"] === "vertical")!;
  const target = { setPointerCapture() {}, parentElement: { getBoundingClientRect: () => ({ width: 1000, height: 500 }) } };
  handle().props.onPointerDown({ currentTarget: target, pointerId: 1, clientX: 500, clientY: 0 });
  handle().props.onPointerMove({ clientX: 700, clientY: 0 });
  const sizes = () => (live.layout(A)!.root as Extract<PaneNode, { kind: "split" }>).sizes;
  expect(sizes()[0]).toBeCloseTo(0.7);
  expect(sizes()[1]).toBeCloseTo(0.3);
  // A drag far past the edge stops at the minimum.
  handle().props.onPointerMove({ clientX: 5000, clientY: 0 });
  expect(sizes()[1]).toBeCloseTo(0.1);
  // After release, moving does nothing.
  handle().props.onPointerUp();
  handle().props.onPointerMove({ clientX: 0, clientY: 0 });
  expect(sizes()[1]).toBeCloseTo(0.1);
  expect(root.id).toBe((live.layout(A)!.root as Extract<PaneNode, { kind: "split" }>).id);
  handle().props.onDoubleClick();
  expect(sizes()).toEqual([0.5, 0.5]);
  expect(view.all().filter((n) => n.props.role === "separator")).toHaveLength(2);
});

it("a terminal is not remounted when its pane moves", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const { one, two, three } = threePanes(live);
  const view = harness(api, live);
  const before = mountPaths(view);
  expect(Object.keys(before).sort()).toEqual([one.id, two.id, three.id].sort());

  const change = (next: PaneLayout | null) => {
    live.setLayout(A, next);
    expect(mountPaths(view)).toEqual(before);
  };
  const l = () => live.layout(A)!;
  // Expand and restore, equalize, resize, focus.
  change(toggleExpand(l(), paneOf(l(), two.id)!));
  change(toggleExpand(l(), paneOf(l(), two.id)!));
  change(resize(l(), (l().root as Extract<PaneNode, { kind: "split" }>).id, [0.3, 0.7]));
  // A tab moves from one pane to another: its view does not move in the tree.
  change(addTab(removeTab(l(), three.id)!, three.id, paneOf(l(), one.id)!));
  expect(leafOf(l(), paneOf(l(), one.id)!).tabs).toEqual([one.id, three.id]);
  // And splits off again.
  change(splitPane(removeTab(l(), three.id)!, paneOf(l(), one.id)!, "down", three.id));
  expect(leaves(l())).toHaveLength(3);
  // Only the front tab of a pane shows.
  change(selectTab(addTab(l(), "ghost", paneOf(l(), one.id)!), one.id));
  expect(shownIds(view)).toEqual([one.id, two.id, three.id]);
});

it("an expanded pane is the only one drawn", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const { two, three } = threePanes(live);
  const view = harness(api, live);
  live.setLayout(A, toggleExpand(live.layout(A)!, paneOf(live.layout(A)!, two.id)!));
  expect(shownIds(view)).toEqual([two.id]);
  expect(panesOf(view)).toHaveLength(1);
  expect(view.find((n) => n.props["data-tab"] === two.id && n.props.role === "tabpanel")!.props.style).toMatchObject({ left: "0%", width: "100%" });
  expect(view.find((n) => n.props["data-tab"] === three.id && n.props.role === "tabpanel")!.props.hidden).toBe(true);
  // Every terminal is still mounted.
  expect(view.terminals()).toHaveLength(3);
});

it("a closed tab hands its pane to a neighbour tab; the last tab of a pane removes the pane", async () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const { one, two, three } = threePanes(live);
  const view = harness(api, live);
  await live.close(three.id);
  expect(panesOf(view)).toHaveLength(2);
  expect(shownIds(view)).toEqual([one.id, two.id]);
  await live.close(two.id);
  expect(panesOf(view)).toHaveLength(1);
  expect(shownIds(view)).toEqual([one.id]);
});

it("the plus menu of a pane starts a tab in that pane", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const { one } = threePanes(live);
  const view = harness(api, live);
  const first = paneOf(live.layout(A)!, one.id)!;
  // The new-tab button of the first pane.
  const strips = view.all().filter((n) => n.type === TabStrip);
  expect(strips[0].props.pane).toBe(first);
  strips[0].props.onMenu(true);
  expect(view.find((n) => n.props.role === "menu")).toBeDefined();
  view.find((n) => n.props.role === "menuitem" && n.props.children === en("terminal.profile.codex"))!.props.onClick();
  const added = live.tabs(A)[3];
  expect(paneOf(live.layout(A)!, added.id)).toBe(first);
  expect(leafOf(live.layout(A)!, first).active).toBe(added.id);
});

it("split right and split down in the plus menu open the default shell in a new pane", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const one = live.open(A, "claude");
  const view = harness(api, live);
  const menuItem = (label: string) => view.find((n) => n.props.role === "menuitem" && n.props.children === label)!;
  view.labelled(en("workspace.tabs.new")).props.onClick();
  menuItem(en("workspace.tabs.split.right")).props.onClick();
  const l = live.layout(A)!;
  expect(leaves(l)).toHaveLength(2);
  expect((l.root as Extract<PaneNode, { kind: "split" }>).dir).toBe("right");
  const added = live.tabs(A)[1];
  expect(added.profileId).toBe("shell");
  expect(l.focused).toBe(paneOf(l, added.id));
  expect(paneOf(l, one.id)).not.toBe(paneOf(l, added.id));
  // Down, from the new pane.
  view.labelled(en("workspace.tabs.new")).props.onClick();
  expect(live.layout(A)!.focused).toBe(paneOf(l, added.id));
});

// ---- tab context menu --------------------------------------------------------------------------

type MenuNode = { id: string; labelKey: string; run?: () => void; disabled?: boolean; checked?: boolean; children?: MenuNode[]; kind?: string };
type View = ReturnType<typeof harness>;
const menuOf = (view: View) => view.find((n) => n.type === ContextMenu);
// Walks ids down a path: `pick(view, "color", "c3")` is the Tab Color > c3 item.
function pick(view: View, ...path: string[]): MenuNode {
  let level = menuOf(view)!.props.items as MenuNode[];
  let found!: MenuNode;
  for (const id of path) {
    found = level.find((i) => i.id === id)!;
    level = found.children ?? [];
  }
  return found;
}
function contextMenu(view: View, id: string) {
  const tab = view.all().find((n) => n.props.className === "ws-tab" && nodes(n.props.children).some((c) => c.props["data-tab"] === id))!;
  tab.props.onContextMenu({ preventDefault() {}, clientX: 10, clientY: 20 });
  return (...path: string[]) => pick(view, ...path);
}

it("a tab context menu offers the SCR-14 items at the pointer", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const one = live.open(A, "shell");
  live.open(A, "claude");
  const view = harness(api, live);
  contextMenu(view, one.id);
  expect(menuOf(view)!.props.at).toEqual({ x: 10, y: 20 });
  const items = menuOf(view)!.props.items as MenuNode[];
  expect(items.map((i) => (i.kind === "separator" ? "-" : i.id))).toEqual([
    "splitRight", "splitDown", "moveToSplit", "-", "pin", "copyTabId", "-", "changeTitle", "color", "-", "close", "closeOthers", "closeToRight",
  ]);
});

it("the menu closes through its own onClose", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const one = live.open(A, "shell");
  const view = harness(api, live);
  contextMenu(view, one.id);
  menuOf(view)!.props.onClose();
  expect(menuOf(view)).toBeUndefined();
});

it("context menu close and close others call Sessions", async () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const one = live.open(A, "shell");
  const two = live.open(A, "claude");
  const three = live.open(A, "codex");
  const close = vi.spyOn(live, "close");
  const view = harness(api, live);
  contextMenu(view, two.id)("close").run!();
  expect(close).toHaveBeenCalledWith(two.id);
  await tick();
  await tick();
  contextMenu(view, one.id)("closeOthers").run!();
  expect(live.tabs(A).map((t) => t.id)).toEqual([one.id]);
  expect(three.id).not.toBe(one.id);
});

it("Close Others keeps pinned tabs", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const one = live.open(A, "shell");
  const two = live.open(A, "claude");
  const three = live.open(A, "codex");
  live.setPinned(three.id, true);
  const view = harness(api, live);
  contextMenu(view, one.id)("closeOthers").run!();
  expect(live.tabs(A).map((t) => t.id).sort()).toEqual([one.id, three.id].sort());
  expect(two.id).not.toBe(three.id);
});

it("pin toggles the label and the tab", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const one = live.open(A, "shell");
  live.open(A, "claude");
  const view = harness(api, live);
  expect(contextMenu(view, one.id)("pin").labelKey).toBe("tabMenu.pin");
  pick(view, "pin").run!();
  expect(live.tabs(A).find((t) => t.id === one.id)!.pinned).toBe(true);
  expect(contextMenu(view, one.id)("pin").labelKey).toBe("tabMenu.unpin");
  pick(view, "pin").run!();
  expect(live.tabs(A).find((t) => t.id === one.id)!.pinned).toBe(false);
});

it("the colour submenu sets the tab colour", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const one = live.open(A, "shell");
  const view = harness(api, live);
  contextMenu(view, one.id)("color", "c3").run!();
  expect(live.tabs(A)[0].color).toBe("c3");
  contextMenu(view, one.id)("color", "none").run!();
  expect(live.tabs(A)[0].color).toBe("none");
});

it("Copy Tab ID writes the tab id to the clipboard", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const one = live.open(A, "shell");
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const view = harness(api, live);
  contextMenu(view, one.id)("copyTabId").run!();
  expect(writeText).toHaveBeenCalledWith(one.id);
});

it("context menu move to split moves the tab into a new pane; a pane's only tab cannot move", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const one = live.open(A, "shell");
  const two = live.open(A, "claude");
  const view = harness(api, live);
  contextMenu(view, one.id)("moveToSplit", "moveDown").run!();
  const l = live.layout(A)!;
  expect(leaves(l)).toHaveLength(2);
  expect((l.root as Extract<PaneNode, { kind: "split" }>).dir).toBe("down");
  expect(l.focused).toBe(paneOf(l, one.id));
  expect(paneOf(l, one.id)).not.toBe(paneOf(l, two.id));
  // Each pane has one tab now: nothing to move off, nothing to close.
  const before = live.layout(A);
  const item = contextMenu(view, two.id);
  expect(item("moveToSplit").disabled).toBe(true);
  expect(item("closeOthers").disabled).toBe(true);
  expect(live.layout(A)).toBe(before);
});

it("Change Title opens the dialog; Save names the tab, Reset gives back the program title, Cancel leaves it", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const tab = live.open(A, "shell");
  live.noteTitle(tab.id, "bash");
  const view = harness(api, live);
  const dialog = () => view.find((n) => n.type === TabTitleDialog);
  contextMenu(view, tab.id)("changeTitle").run!();
  expect(dialog()!.props.title).toBe("bash");
  dialog()!.props.onSave("build");
  expect(live.tabs(A)[0]).toMatchObject({ title: "build", renamed: true });
  expect(dialog()).toBeUndefined();
  contextMenu(view, tab.id)("changeTitle").run!();
  expect(dialog()!.props.title).toBe("build");
  dialog()!.props.onCancel();
  expect(dialog()).toBeUndefined();
  expect(live.tabs(A)[0].title).toBe("build");
  contextMenu(view, tab.id)("changeTitle").run!();
  dialog()!.props.onSave(null);
  expect(live.tabs(A)[0]).toMatchObject({ title: "bash", renamed: false });
});

it("double click on a tab renames it inline", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const tab = live.open(A, "shell");
  const view = harness(api, live);
  const strip = () => view.find((n) => n.props["data-tab"] === tab.id && typeof n.props.onDoubleClick === "function")!;
  strip().props.onDoubleClick();
  const input = view.find((n) => n.type === "input" && n.props["aria-label"] === en("panes.rename"))!;
  input.props.onKeyDown({ key: "Enter", currentTarget: { value: "  build  " } });
  expect(live.tabs(A)[0]).toMatchObject({ title: "build", renamed: true });
  // Escape leaves the name alone.
  strip().props.onDoubleClick();
  view.find((n) => n.type === "input")!.props.onKeyDown({ key: "Escape", currentTarget: { value: "zzz" } });
  expect(live.tabs(A)[0].title).toBe("build");
  expect(view.find((n) => n.type === "input")).toBeUndefined();
});

// ---- pinned and coloured tabs --------------------------------------------------------------------

const rowOf = (view: View, id: string) =>
  view.all().find((n) => n.props.className === "ws-tab" && nodes(n.props.children).some((c) => c.props["data-tab"] === id))!;

it("a pinned tab shows the pin glyph and has no close button", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const one = live.open(A, "shell");
  const two = live.open(A, "claude");
  live.setPinned(one.id, true);
  const view = harness(api, live);
  const pinned = nodes(rowOf(view, one.id).props.children);
  expect(rowOf(view, one.id).props["data-pinned"]).toBe(true);
  expect(pinned.some((n) => n.props.className === "ws-tab-pin" && n.props["aria-label"] === en("tabMenu.pinned"))).toBe(true);
  expect(pinned.some((n) => n.props.className === "ws-tab-close")).toBe(false);
  // The other tab is unchanged.
  const plain = nodes(rowOf(view, two.id).props.children);
  expect(plain.some((n) => n.props.className === "ws-tab-pin")).toBe(false);
  expect(plain.some((n) => n.props.className === "ws-tab-close")).toBe(true);
});

it("a coloured tab carries its colour token; no colour leaves the row plain", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const one = live.open(A, "shell");
  const two = live.open(A, "claude");
  live.setColor(one.id, "c4");
  const view = harness(api, live);
  expect(rowOf(view, one.id).props.style).toEqual({ "--ws-tab-color": "var(--x-tab-color-4)" });
  expect(rowOf(view, one.id).props["data-color"]).toBe("c4");
  expect(rowOf(view, two.id).props.style).toBeUndefined();
  expect(rowOf(view, two.id).props["data-color"]).toBeUndefined();
});

// ---- terminal right-click menu -----------------------------------------------------------------

function fakeHandle(selection = true) {
  const calls: string[] = [];
  const handle: TerminalHandle = {
    copy: async () => { calls.push("copy"); return true; },
    paste: async () => { calls.push("paste"); },
    selectAll: () => void calls.push("selectAll"),
    clear: () => void calls.push("clear"),
    reset: () => void calls.push("reset"),
    find: () => void calls.push("find"),
    hasSelection: () => selection,
    focus: () => void calls.push("focus"),
    lines: () => ["$ ls", "a b", "", ""],
  };
  return { calls, handle };
}
function openTerminalMenu(view: View, id: string, handle: TerminalHandle) {
  view.terminals().find((n) => n.props.id === id)!.props.onMenu({ x: 5, y: 6 }, handle);
  return (...path: string[]) => pick(view, ...path);
}

it("a right click in the terminal opens its menu at the pointer; items call the handle", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const tab = live.open(A, "shell");
  const view = harness(api, live);
  const { calls, handle } = fakeHandle();
  const item = openTerminalMenu(view, tab.id, handle);
  expect(menuOf(view)!.props.at).toEqual({ x: 5, y: 6 });
  for (const id of ["copy", "paste", "selectAll", "clear", "reset"]) item(id).run!();
  expect(calls).toEqual(["copy", "paste", "selectAll", "clear", "reset"]);
  expect(item("copy").disabled).toBeFalsy();
  menuOf(view)!.props.onClose();
  expect(menuOf(view)).toBeUndefined();
  expect(openTerminalMenu(view, tab.id, fakeHandle(false).handle)("copy").disabled).toBe(true);
});

it("terminal menu: Copy Terminal ID, Copy Pane ID and Copy Context write the clipboard", async () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const tab = live.open(A, "shell");
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const view = harness(api, live, A, true, { branch: "oak" });
  const item = openTerminalMenu(view, tab.id, fakeHandle().handle);
  item("copyTerminalId").run!();
  item("copyPaneId").run!();
  item("copyContext").run!();
  await tick();
  const pane = paneOf(live.layout(A)!, tab.id);
  const written = writeText.mock.calls.map((c) => (c as unknown[])[0] as string);
  expect(written.slice(0, 2)).toEqual([tab.id, pane]);
  expect(written[2]).toContain(A);
  expect(written[2]).toContain("oak");
  expect(written[2]).toContain("$ ls\na b");
});

it("terminal menu: Set Title opens the dialog, Split Right opens a shell in a new pane, Close closes the tab", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const tab = live.open(A, "shell");
  const view = harness(api, live);
  const item = openTerminalMenu(view, tab.id, fakeHandle().handle);
  item("setTitle").run!();
  expect(view.find((n) => n.type === TabTitleDialog)).toBeDefined();
  item("splitRight").run!();
  expect(leaves(live.layout(A)!)).toHaveLength(2);
  const close = vi.spyOn(live, "close");
  openTerminalMenu(view, tab.id, fakeHandle().handle)("close").run!();
  expect(close).toHaveBeenCalledWith(tab.id);
});

const custom = (over: Partial<Profile> = {}): Profile => ({
  id: "aider", name: "Aider", cli: null, program: "aider", args: [], env: [], model: null, effort: null,
  permissions: null, account: null, startup: [], enabled: true, ...over,
});
const profileOf = async (api: Api, id: string) => (await api.profiles()).profiles.find((p) => p.profile.id === id)!.profile;
// The `+` button lives in a pane's strip; an empty worktree has no pane, so a shell opens first.
const openMenu = (view: ReturnType<typeof harness>, live: Sessions) => {
  if (!live.tabs(A).length) live.open(A, "shell");
  view.labelled(en("workspace.tabs.new")).props.onClick();
};
const group = (view: ReturnType<typeof harness>, label: string) => view.find((n) => n.props.role === "group" && n.props["aria-label"] === label);
const items = (g: Node | undefined) => (g ? nodes(g.props.children).filter((n) => n.props.role === "menuitem").map((n) => n.props.children) : []);

it("plus_menu_lists_agents_and_shells", async () => {
  const api = createMockApi({});
  // Gemini is not installed in the mock; codex is turned off here.
  store.view = await api.profilePut({ ...(await profileOf(api, "codex")), enabled: false });
  const live = (sessions = new Sessions(api));
  const view = harness(api, live);
  openMenu(view, live);
  expect(items(group(view, en("workspace.tabs.agents")))).toEqual([en("terminal.profile.claude")]);
  expect(items(group(view, en("workspace.tabs.shells")))).toEqual(["PowerShell", "CMD", "WSL Ubuntu"]);
  // Each group says what it holds.
  expect(view.html()).toContain(`>${en("workspace.tabs.agents")}<`);
});

it("wsl_item_opens_that_shell", async () => {
  const api = createMockApi({});
  const spawn = vi.spyOn(api, "ptySpawn");
  store.view = await api.profiles();
  const live = (sessions = new Sessions(api));
  const view = harness(api, live);
  openMenu(view, live);
  view.find((n) => n.props.role === "menuitem" && n.props.children === "WSL Ubuntu")!.props.onClick();
  const tab = live.tabs(A).at(-1)!;
  expect(tab).toMatchObject({ worktree: A, profileId: "shell:wsl:Ubuntu", agent: false });
  expect(view.find((n) => n.props.role === "menu")).toBeUndefined();
  await run(view.terminals().find((t) => t.props.id === tab.id)!);
  expect(spawn.mock.calls.find((c) => c[0] === tab.id)!.slice(0, 3)).toEqual([tab.id, A, "shell:wsl:Ubuntu"]);
  // A shell never asks.
  expect(view.dialog().props.open).toBe(false);
  expect(view.html()).toContain(">WSL Ubuntu<");
});

it("skip_tab_shows_badge", async () => {
  const api = createMockApi({});
  store.view = await api.profilesDefaults("skip", "claude", null);
  const live = (sessions = new Sessions(api));
  const view = harness(api, live);
  const shell = live.open(A, "shell");
  await run(view.terminals()[0]);
  const tab = live.open(A, "claude");
  await run(view.terminals()[1]);
  view.dialog().props.onConfirm();
  await tick();
  await run(view.terminals()[1]);
  expect(live.tabs(A).find((t) => t.id === tab.id)!.permissions).toBe("skip");
  const badge = (id: string) =>
    nodes(view.find((n) => n.props.role === "tab" && n.props["data-tab"] === id)!.props.children).find((n) => n.props.className === "ws-tab-skip");
  expect(badge(tab.id)).toBeDefined();
  expect(badge(shell.id)).toBeUndefined();
  const html = view.html();
  expect(html).toContain(`>${en("workspace.tabs.skip")}<`);
  expect(html).toContain('class="ws-tab-skip-dot"');
});

it("approval_dialog_warns_on_skip", async () => {
  const api = createMockApi({});
  store.view = await api.profiles();
  const live = (sessions = new Sessions(api));
  const view = harness(api, live);
  live.open(A, "claude");
  await run(view.terminals()[0]);
  // Asking mode: the plain question.
  expect(view.dialog().props.open).toBe(true);
  expect(view.dialog().props.warning).toBeUndefined();
  view.dialog().props.onCancel();

  store.view = await api.profilesDefaults("skip", "claude", null);
  live.open(A, "claude");
  await run(view.terminals()[0]);
  expect(view.dialog().props.open).toBe(true);
  expect(view.dialog().props.warning).toBe(en("terminal.approve.skip"));
  const markup = renderToStaticMarkup(view.dialog());
  expect(markup).toContain('class="dialog-warn"');
  expect(markup).toContain(en("terminal.approve.skip"));
});

it("custom_profile_tab_uses_its_name", async () => {
  const api = createMockApi({});
  store.view = await api.profilePut(custom());
  const live = (sessions = new Sessions(api));
  const view = harness(api, live);
  openMenu(view, live);
  expect(items(group(view, en("workspace.tabs.agents")))).toContain("Aider");
  view.find((n) => n.props.role === "menuitem" && n.props.children === "Aider")!.props.onClick();
  const tab = live.tabs(A).at(-1)!;
  expect(tab.profileId).toBe("aider");
  const html = view.html();
  expect(html).toContain('<span class="ws-tab-name">Aider</span>');
  expect(html).toContain(">A</span>");
  expect(view.labelled(en("workspace.tabs.close", { name: "Aider" }))).toBeDefined();

  // Once the profile is gone the tab falls back to its id.
  store.view = await api.profileRemove("aider");
  expect(view.html()).toContain('<span class="ws-tab-name">aider</span>');
});

it("restart_of_disabled_profile_shows_error", async () => {
  const api = createMockApi({});
  let fire: (e: PtyExit) => void = () => {};
  vi.spyOn(api, "onPtyExit").mockImplementation(async (cb) => ((fire = cb), () => {}));
  await api.ptyApprove("codex", null);
  store.view = await api.profiles();
  const live = (sessions = new Sessions(api));
  const view = harness(api, live);
  const tab = live.open(A, "codex");
  await run(view.terminals()[0]);
  fire({ id: tab.id, code: 0 });

  // Codex is turned off while its tab sits exited.
  store.view = await api.profilePut({ ...(await profileOf(api, "codex")), enabled: false });
  expect(view.html()).toContain(`<span class="ws-tab-name">${en("terminal.profile.codex")}</span>`);
  view.find((n) => n.type === "button" && n.props.className === "ws-tab-again")!.props.onClick();
  await run(view.terminals()[0]);
  await tick();
  const banner = view.find((n) => n.props.role === "alert")!;
  expect(renderToStaticMarkup(banner)).toContain(en("error.profile_off"));
  // The failed start leaves nothing behind but the banner.
  expect(live.tabs(A)).toEqual([]);
});

it("agent_exit_shows_restart_with_same_account", async () => {
  const api = createMockApi({});
  let fire: (e: PtyExit) => void = () => {};
  vi.spyOn(api, "onPtyExit").mockImplementation(async (cb) => ((fire = cb), () => {}));
  const spawn = vi.spyOn(api, "ptySpawn");
  await api.ptyApprove("claude", "work");
  store.view = await api.profiles();
  const live = (sessions = new Sessions(api));
  const view = harness(api, live);
  const tab = live.open(A, "claude", "work");
  await run(view.terminals()[0]);
  expect(view.find((n) => n.props.className === "ws-tab-again")).toBeUndefined();

  fire({ id: tab.id, code: 0 });
  const chip = view.find((n) => n.type === "button" && n.props.className === "ws-tab-again")!;
  expect(chip.props.children).toBe(en("workspace.tabs.restart"));
  chip.props.onClick();
  const [next] = live.tabs(A);
  expect(next.id).not.toBe(tab.id);
  expect(next).toMatchObject({ profileId: "claude", account: "work" });
  await run(view.terminals()[0]);
  expect(spawn).toHaveBeenCalledTimes(2);
  expect([spawn.mock.calls[1][0], ...spawn.mock.calls[1].slice(1, 4)]).toEqual([next.id, A, "claude", "work"]);
});

it("shell_exit_keeps_run_again", async () => {
  const api = createMockApi({});
  let fire: (e: PtyExit) => void = () => {};
  vi.spyOn(api, "onPtyExit").mockImplementation(async (cb) => ((fire = cb), () => {}));
  store.view = await api.profiles();
  const live = (sessions = new Sessions(api));
  const view = harness(api, live);
  const tab = live.open(A, "shell:cmd");
  await run(view.terminals()[0]);
  fire({ id: tab.id, code: 0 });
  const chip = view.find((n) => n.type === "button" && n.props.className === "ws-tab-again")!;
  expect(chip.props.children).toBe(en("workspace.tabs.again"));
  expect(view.html()).not.toContain(en("workspace.tabs.restart"));
});

// Runs the effects of one fresh draw against a stubbed window; hands back its keydown listeners.
function keys(view: ReturnType<typeof harness>) {
  const listeners = new Set<(e: KeyboardEvent) => void>();
  const add = vi.fn((type: string, fn: (e: KeyboardEvent) => void) => void (type === "keydown" && listeners.add(fn)));
  const remove = vi.fn((type: string, fn: (e: KeyboardEvent) => void) => void (type === "keydown" && listeners.delete(fn)));
  vi.stubGlobal("window", { addEventListener: add, removeEventListener: remove });
  hooks.effects = [];
  view.draw();
  const cleanups = hooks.effects.map((effect) => effect()).filter((c): c is () => void => typeof c === "function");
  const press = (over: Partial<KeyboardEvent> = {}) => {
    const e = { key: "t", code: "KeyT", ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, repeat: false, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...over };
    for (const fn of [...listeners]) fn(e as unknown as KeyboardEvent);
    return e;
  };
  return { listeners, add, press, cleanup: () => cleanups.forEach((c) => c()) };
}

it("ctrl_alt_t_opens_default_agent", async () => {
  const api = createMockApi({});
  store.view = await api.profilesDefaults("ask", "codex", null);
  const live = (sessions = new Sessions(api));

  // A hidden worktree does not listen.
  const hidden = keys(harness(api, live, B, false));
  expect(hidden.listeners.size).toBe(0);
  hidden.cleanup();

  const shown = keys(harness(api, live, A, true));
  expect(shown.listeners.size).toBe(1);
  // A held key repeats; only the first press counts, and other chords do nothing.
  shown.press({ repeat: true });
  shown.press({ altKey: false, shiftKey: true });
  shown.press({ key: "y", code: "KeyY" });
  expect(live.tabs(A)).toEqual([]);
  const e = shown.press();
  expect(e.preventDefault).toHaveBeenCalled();
  expect(live.tabs(A).map((t) => t.profileId)).toEqual(["codex"]);
  expect(live.tabs(B)).toEqual([]);

  shown.cleanup();
  expect(shown.listeners.size).toBe(0);
});

// ---- Workspace keys: tab and pane actions ----

/** One key press against a fresh draw, so each press sees the state the last one left. */
function press(view: ReturnType<typeof harness>, over: Partial<KeyboardEvent>) {
  const k = keys(view);
  const e = k.press({ ctrlKey: false, altKey: false, ...over });
  k.cleanup();
  return e;
}
const CTRL_T = { key: "t", code: "KeyT", ctrlKey: true };
const CTRL_W = { key: "w", code: "KeyW", ctrlKey: true };
const CTRL_TAB = { key: "Tab", code: "Tab", ctrlKey: true };
const selected = (view: ReturnType<typeof harness>) =>
  view.all().filter((n) => n.props.role === "tab" && n.props["aria-selected"] === true).map((n) => n.props["data-tab"]);

it("ctrl_t_opens_the_default_shell_and_ctrl_w_closes_it", async () => {
  const api = createMockApi({});
  store.view = await api.profilesDefaults("ask", "codex", null);
  const live = (sessions = new Sessions(api));
  const view = harness(api, live);
  const e = press(view, CTRL_T);
  expect(e.preventDefault).toHaveBeenCalled();
  expect(live.tabs(A).map((t) => t.profileId)).toEqual([store.view.defaultShell]);
  expect(live.tabs(A)[0].agent).toBe(false);
  press(view, CTRL_W);
  expect(live.tabs(A)).toEqual([]);
});

it("ctrl_t_with_no_shell_opens_the_menu", async () => {
  const api = createMockApi({});
  store.view = { ...(await api.profilesDefaults("ask", "codex", null)), shells: [] };
  const live = (sessions = new Sessions(api));
  const view = harness(api, live);
  // No pane yet: no menu to open, so the key goes on (the empty view offers the launchers).
  expect(press(view, CTRL_T).preventDefault).not.toHaveBeenCalled();
  // With a pane, its `+` menu opens instead of a shell.
  live.open(A, "claude");
  expect(view.find((n) => n.props.role === "menu")).toBeUndefined();
  expect(press(view, CTRL_T).preventDefault).toHaveBeenCalled();
  expect(live.tabs(A)).toHaveLength(1);
  expect(view.find((n) => n.props.role === "menu")).toBeDefined();
});

it("keys do nothing in a worktree that is not on screen", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const k = keys(harness(api, live, A, false));
  expect(k.listeners.size).toBe(0);
});

it("ctrl_w_on_an_agent_asks_first", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const agent = live.open(A, "claude");
  live.noteTitleStatus(agent.id, "working");
  const view = harness(api, live);
  const ask = () => view.find((n) => n.type === CloseTabsDialog);
  expect(ask()).toBeUndefined();
  press(view, CTRL_W);
  expect(live.tabs(A)).toHaveLength(1);
  // Cancel keeps it; confirm closes it.
  ask()!.props.onCancel();
  expect(ask()).toBeUndefined();
  press(view, CTRL_W);
  ask()!.props.onConfirm();
  expect(live.tabs(A).map((t) => t.id)).not.toContain(agent.id);
  expect(ask()).toBeUndefined();
});

it("ctrl_w_on_the_review_tab_closes_it", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const view = harness(api, live, A, true, { reveal: { file: "a.ts", seq: 1 } });
  expect(selected(view)).toEqual(["review:"]);
  press(view, CTRL_W);
  expect(view.find((n) => n.props["data-tab"] === "review:")).toBeUndefined();
});

it("ctrl_tab_cycles_and_alt_n_picks_a_tab", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const [a, b, c] = ["shell", "shell", "shell"].map((p) => live.open(A, p as "shell").id);
  const view = harness(api, live);
  expect(selected(view)).toEqual([c]);
  press(view, CTRL_TAB);
  expect(selected(view)).toEqual([a]);
  press(view, { ...CTRL_TAB, shiftKey: true });
  expect(selected(view)).toEqual([c]);
  press(view, { key: "2", code: "Digit2", altKey: true });
  expect(selected(view)).toEqual([b]);
  press(view, { key: "9", code: "Digit9", altKey: true });
  expect(selected(view)).toEqual([c]);
  // No fourth tab: the key goes on to the terminal.
  const e = press(view, { key: "4", code: "Digit4", altKey: true });
  expect(e.preventDefault).not.toHaveBeenCalled();
  expect(selected(view)).toEqual([c]);
});

it("ctrl_tab_in_mru_mode_goes_to_the_tab_used_before_and_keeps_walking_one_list", () => {
  vi.useFakeTimers();
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const [a, b, c] = ["shell", "shell", "shell"].map((p) => live.open(A, p as "shell").id);
  // Focus order: c now, b before it, a before that.
  for (const id of [a, b, c]) live.noteFocused(A, id);
  const view = harness(api, live);
  expect(selected(view)).toEqual([c]);
  press(view, CTRL_TAB);
  expect(selected(view)).toEqual([b]);
  // Held: the list is the one the walk started with, although the focus moved.
  press(view, CTRL_TAB);
  expect(selected(view)).toEqual([a]);
  press(view, { ...CTRL_TAB, shiftKey: true });
  expect(selected(view)).toEqual([b]);
  // The walk passed through a without recording it; once the focus settles only b is the newest.
  expect(live.recentTabs(A)).toEqual([c, b, a]);
  view.draw();
  vi.advanceTimersByTime(600);
  expect(live.recentTabs(A)[0]).toBe(b);
  // A new walk starts from the new order: b, c, a.
  press(view, CTRL_TAB);
  expect(selected(view)).toEqual([c]);
});

it("ctrl_tab_in_strip_mode_follows_the_strip_order", () => {
  vi.useFakeTimers();
  setNavigationSettings({ ...NAVIGATION_DEFAULTS, tabOrder: "sequential" });
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const [a, b, c] = ["shell", "shell", "shell"].map((p) => live.open(A, p as "shell").id);
  for (const id of [a, b, c]) live.noteFocused(A, id);
  const view = harness(api, live);
  expect(selected(view)).toEqual([c]);
  // MRU would go to b; the strip wraps to a.
  press(view, CTRL_TAB);
  expect(selected(view)).toEqual([a]);
  press(view, CTRL_TAB);
  expect(selected(view)).toEqual([b]);
});

// ---- Close confirmations (Settings → General → Navigation) ----

const strip = (view: ReturnType<typeof harness>) => view.find((n) => n.type === TabStrip)!.props;
const asking = (view: ReturnType<typeof harness>) => view.find((n) => n.type === CloseTabsDialog);
const working = (live: Sessions, profile: "claude" | "shell" = "claude") => {
  const tab = live.open(A, profile);
  live.noteTitleStatus(tab.id, "working");
  return tab;
};

it("the close button of an agent at work asks first; Cancel keeps it, confirm closes it", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const agent = working(live);
  const view = harness(api, live);
  strip(view).onClose(agent.id);
  expect(asking(view)!.props.reason).toBe("running");
  expect(live.tabs(A)).toHaveLength(1);
  asking(view)!.props.onCancel();
  expect(asking(view)).toBeUndefined();
  expect(live.tabs(A)).toHaveLength(1);
  strip(view).onClose(agent.id);
  asking(view)!.props.onConfirm();
  expect(live.tabs(A)).toEqual([]);
});

it("an idle agent and a shell close at once", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const agent = live.open(A, "claude");
  const shell = live.open(A, "shell");
  const view = harness(api, live);
  strip(view).onClose(agent.id);
  strip(view).onClose(shell.id);
  expect(asking(view)).toBeUndefined();
  expect(live.tabs(A)).toEqual([]);
});

it("confirmCloseRunning off closes an agent at work at once", () => {
  setNavigationSettings({ ...NAVIGATION_DEFAULTS, confirmCloseRunning: false });
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const agent = working(live);
  const view = harness(api, live);
  strip(view).onClose(agent.id);
  expect(asking(view)).toBeUndefined();
  expect(live.tabs(A)).toEqual([]);
});

it("a pinned tab asks before it closes, from the key and from the menu, unless the setting is off", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const shell = live.open(A, "shell");
  live.setPinned(shell.id, true);
  const view = harness(api, live);
  press(view, CTRL_W);
  expect(asking(view)!.props.reason).toBe("pinned");
  asking(view)!.props.onCancel();
  expect(live.tabs(A)).toHaveLength(1);
  strip(view).onClose(shell.id);
  expect(asking(view)!.props.reason).toBe("pinned");
  asking(view)!.props.onConfirm();
  expect(live.tabs(A)).toEqual([]);

  setNavigationSettings({ ...NAVIGATION_DEFAULTS, confirmClosePinned: false });
  const again = live.open(A, "shell");
  live.setPinned(again.id, true);
  strip(view).onClose(again.id);
  expect(asking(view)).toBeUndefined();
  expect(live.tabs(A)).toEqual([]);
});

it("Close Others and Close to the Right ask once when a running tab is in the set, and skip pinned tabs", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const pinned = live.open(A, "shell");
  live.setPinned(pinned.id, true);
  const keep = live.open(A, "shell");
  const busy = working(live);
  const busy2 = working(live);
  const view = harness(api, live);
  strip(view).onCloseOthers(keep.id);
  expect(asking(view)!.props.reason).toBe("running");
  expect(live.tabs(A)).toHaveLength(4);
  asking(view)!.props.onCancel();
  expect(live.tabs(A)).toHaveLength(4);
  strip(view).onCloseOthers(keep.id);
  asking(view)!.props.onConfirm();
  // One question for both agents; the pinned tab stays.
  expect(live.tabs(A).map((t) => t.id)).toEqual([pinned.id, keep.id]);
  expect([busy.id, busy2.id]).not.toContain(live.tabs(A)[0].id);
  // Nothing but a pinned tab to the right: nothing to ask, nothing to close.
  strip(view).onCloseToRight(keep.id);
  expect(asking(view)).toBeUndefined();
  expect(live.tabs(A)).toHaveLength(2);
});

const CTRL_SHIFT_D = { key: "D", code: "KeyD", ctrlKey: true, shiftKey: true };
const ALT_SHIFT_D = { key: "D", code: "KeyD", altKey: true, shiftKey: true };
const CTRL_RB = { key: "]", code: "BracketRight", ctrlKey: true };
const CTRL_LB = { key: "[", code: "BracketLeft", ctrlKey: true };
const focusedLeaf = (live: Sessions) => {
  const l = live.layout(A)!;
  return leafOf(l, l.focused);
};
/** The handlers the last draw gave useKeymap; for an action with no default chord. */
const handlers = (view: ReturnType<typeof harness>) => {
  view.draw();
  return vi.mocked(useKeymap).mock.lastCall![0];
};

it("tab keys stay inside the focused pane", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const { one, two, three } = threePanes(live);
  // The top right pane gets a second tab, and the focus.
  live.setLayout(A, selectTab(live.layout(A)!, two.id));
  const four = live.open(A, "shell");
  const view = harness(api, live);
  expect(focusedLeaf(live).tabs).toEqual([two.id, four.id]);
  expect(focusedLeaf(live).active).toBe(four.id);
  press(view, CTRL_TAB);
  expect(focusedLeaf(live).active).toBe(two.id);
  press(view, { ...CTRL_TAB, shiftKey: true });
  expect(focusedLeaf(live).active).toBe(four.id);
  press(view, { key: "1", code: "Digit1", altKey: true });
  expect(focusedLeaf(live).active).toBe(two.id);
  press(view, { key: "9", code: "Digit9", altKey: true });
  expect(focusedLeaf(live).active).toBe(four.id);
  // Alt+3: this pane has two tabs, so the key goes on and focus stays in the pane.
  expect(press(view, { key: "3", code: "Digit3", altKey: true }).preventDefault).not.toHaveBeenCalled();
  expect(focusedLeaf(live).tabs).toEqual([two.id, four.id]);
  expect(paneOf(live.layout(A)!, one.id)).not.toBe(live.layout(A)!.focused);
  expect(paneOf(live.layout(A)!, three.id)).not.toBe(live.layout(A)!.focused);
});

it("ctrl_t_opens_the_shell_in_the_focused_pane", async () => {
  const api = createMockApi({});
  store.view = await api.profilesDefaults("ask", "codex", null);
  const live = (sessions = new Sessions(api));
  const { one } = threePanes(live);
  live.setLayout(A, selectTab(live.layout(A)!, one.id));
  const view = harness(api, live);
  press(view, CTRL_T);
  const opened = live.tabs(A).at(-1)!;
  expect(opened.profileId).toBe(store.view.defaultShell);
  expect(paneOf(live.layout(A)!, opened.id)).toBe(paneOf(live.layout(A)!, one.id));
  expect(focusedLeaf(live).active).toBe(opened.id);
  expect(leaves(live.layout(A)!)).toHaveLength(3);
});

it("split keys open the default shell in a new pane beside the focused one", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const view = harness(api, live);
  // No tab, no pane: nothing to split, the key goes on.
  expect(press(view, CTRL_SHIFT_D).preventDefault).not.toHaveBeenCalled();
  expect(live.tabs(A)).toEqual([]);

  const one = live.open(A, "shell");
  expect(press(view, CTRL_SHIFT_D).preventDefault).toHaveBeenCalled();
  let l = live.layout(A)!;
  expect(live.tabs(A)).toHaveLength(2);
  expect(leaves(l)).toHaveLength(2);
  expect((l.root as Extract<PaneNode, { kind: "split" }>).dir).toBe("right");
  const two = live.tabs(A)[1];
  expect(l.focused).toBe(paneOf(l, two.id));
  expect(paneOf(l, one.id)).not.toBe(paneOf(l, two.id));
  // The new terminal is in front of the focused pane and takes the keyboard.
  expect(view.terminals().find((n) => n.props.id === two.id)!.props.focusSeq).toBeGreaterThan(0);

  press(view, ALT_SHIFT_D);
  l = live.layout(A)!;
  expect(leaves(l)).toHaveLength(3);
  const three = live.tabs(A)[2];
  expect(l.focused).toBe(paneOf(l, three.id));
  // Down splits the pane of `two` only: the root stays a right split, its second child a down split.
  const root = l.root as Extract<PaneNode, { kind: "split" }>;
  expect(root.dir).toBe("right");
  expect((root.children[1] as Extract<PaneNode, { kind: "split" }>).dir).toBe("down");
});

it("pane_next_and_prev_move_focus_and_give_the_terminal_the_keyboard", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const { one, two, three } = threePanes(live);
  const view = harness(api, live);
  const focusOf = (id: string) => view.terminals().find((n) => n.props.id === id)!.props.focusSeq;
  expect(live.layout(A)!.focused).toBe(paneOf(live.layout(A)!, three.id));
  // Reading order wraps: three -> one.
  expect(press(view, CTRL_RB).preventDefault).toHaveBeenCalled();
  expect(live.layout(A)!.focused).toBe(paneOf(live.layout(A)!, one.id));
  expect(focusOf(one.id)).toBeGreaterThan(0);
  expect(focusOf(three.id)).toBeUndefined();
  press(view, CTRL_LB);
  expect(live.layout(A)!.focused).toBe(paneOf(live.layout(A)!, three.id));
  press(view, CTRL_LB);
  expect(live.layout(A)!.focused).toBe(paneOf(live.layout(A)!, two.id));
});

it("pane_next_with_one_pane_lets_the_key_on", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  live.open(A, "shell");
  const view = harness(api, live);
  const before = live.layout(A);
  expect(press(view, CTRL_RB).preventDefault).not.toHaveBeenCalled();
  expect(live.layout(A)).toBe(before);
});

it("pane_expand_toggles_and_the_expansion_follows_focus", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const { one, three } = threePanes(live);
  const view = harness(api, live);
  const ENTER = { key: "Enter", code: "Enter", ctrlKey: true, shiftKey: true };
  press(view, ENTER);
  expect(live.layout(A)!.expanded).toBe(paneOf(live.layout(A)!, three.id));
  expect(shownIds(view)).toEqual([three.id]);
  // Moving focus moves the expansion: the focused pane is never a hidden one.
  press(view, CTRL_RB);
  expect(live.layout(A)!.expanded).toBe(paneOf(live.layout(A)!, one.id));
  expect(shownIds(view)).toEqual([one.id]);
  press(view, ENTER);
  expect(live.layout(A)!.expanded).toBeNull();
  expect(shownIds(view)).toHaveLength(3);
});

it("pane_equalize_evens_out_the_sizes", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  threePanes(live);
  const rootOf = () => live.layout(A)!.root as Extract<PaneNode, { kind: "split" }>;
  live.setLayout(A, resize(live.layout(A)!, rootOf().id, [0.8, 0.2]));
  const view = harness(api, live);
  expect(rootOf().sizes[0]).toBeCloseTo(0.8);
  expect(press(view, { key: "=", code: "Equal", ctrlKey: true, shiftKey: true }).preventDefault).toHaveBeenCalled();
  expect(rootOf().sizes).toEqual([0.5, 0.5]);
});

it("pane_close_closes_every_tab_of_the_focused_pane_after_asking_for_an_agent", async () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const { one, two, three } = threePanes(live);
  const four = live.open(A, "shell");
  live.noteTitleStatus(three.id, "working");
  const view = harness(api, live);
  // The focused pane holds codex (an agent at work) and a shell: ask first.
  expect(focusedLeaf(live).tabs).toEqual([three.id, four.id]);
  const ask = () => view.find((n) => n.type === CloseTabsDialog);
  expect(handlers(view)["pane.close"]!()).not.toBe(false);
  expect(ask()).toBeDefined();
  expect(live.tabs(A)).toHaveLength(4);
  ask()!.props.onConfirm();
  await tick();
  expect(live.tabs(A).map((t) => t.id)).toEqual([one.id, two.id]);
  expect(leaves(live.layout(A)!)).toHaveLength(2);
  expect(ask()).toBeUndefined();
});

it("pane_close_of_shells_closes_at_once_and_with_no_pane_lets_the_key_on", async () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const view = harness(api, live);
  expect(handlers(view)["pane.close"]!()).toBe(false);
  const one = live.open(A, "shell");
  live.open(A, "shell");
  handlers(view)["pane.close"]!();
  await tick();
  expect(live.tabs(A)).toEqual([]);
  expect(live.layout(A)).toBeNull();
  expect(view.find((n) => n.type === CloseTabsDialog)).toBeUndefined();
  expect(one.id).toBeDefined();
});

it("tooltips of the strip name the chord", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  live.open(A, "shell");
  const view = harness(api, live);
  expect(view.labelled(en("workspace.tabs.new")).props.title).toBe(en("keys.hint", { label: en("workspace.tabs.new"), chord: "Ctrl+T" }));
  const close = view.find((n) => n.props.className === "ws-tab-close")!;
  expect(close.props.title).toBe(en("keys.hint", { label: close.props["aria-label"], chord: "Ctrl+W" }));
});

// ---- file tabs ----------------------------------------------------------------------------

const readyFile = (worktree: string, rel: string, text = "one") => {
  fileTabs.open(worktree, rel);
  fileTabs.loaded(worktree, rel, { rel, text, kind: "text", size: text.length, hash: "h1", eol: "lf" });
};

describe("file tabs", () => {
  beforeEach(() => fileTabs.reset());
  afterEach(() => fileTabs.reset());

  const stripItems = (view: ReturnType<typeof harness>) => view.find((n) => n.type === TabStrip)!.props.items as { id: string; file?: { rel: string; dirty: boolean } }[];

  it("shows an open file as a tab with its name, a pane view and a dirty mark after an edit", () => {
    const api = createMockApi({});
    const live = (sessions = new Sessions(api));
    readyFile(A, "src/a.ts");
    const view = harness(api, live);
    expect(stripItems(view)).toEqual([{ id: "file:src/a.ts", tab: null, file: { rel: "src/a.ts", dirty: false } }]);
    expect(view.find((n) => n.props["data-tab"] === "file:src/a.ts")).toBeDefined();
    expect(view.html()).toContain("a.ts");
    expect(view.html()).not.toContain("ws-tab-dirty");
    fileTabs.edit(A, "src/a.ts", "two");
    expect(view.html()).toContain("ws-tab-dirty");
    expect(view.html()).toContain(en("files.dirty"));
  });

  it("keeps a file to its own worktree", () => {
    const api = createMockApi({});
    const live = (sessions = new Sessions(api));
    readyFile(A, "a.ts");
    const other = harness(api, live, B);
    expect(other.find((n) => n.type === TabStrip)).toBeUndefined();
    expect(other.find((n) => n.props["data-tab"] === "file:a.ts")).toBeUndefined();
  });

  it("closes a clean tab at once", () => {
    const api = createMockApi({});
    const live = (sessions = new Sessions(api));
    readyFile(A, "a.ts");
    const view = harness(api, live);
    view.find((n) => n.type === TabStrip)!.props.onClose("file:a.ts");
    expect(fileTabs.get(A, "a.ts")).toBeNull();
    expect(view.find((n) => n.type === UnsavedDialog)).toBeUndefined();
  });

  it("asks before closing a dirty tab; Don't Save closes without a write", () => {
    const api = createMockApi({});
    const write = vi.spyOn(api, "fileWrite");
    const live = (sessions = new Sessions(api));
    readyFile(A, "a.ts");
    fileTabs.edit(A, "a.ts", "changed");
    const view = harness(api, live);
    view.find((n) => n.type === TabStrip)!.props.onClose("file:a.ts");
    const ask = () => view.find((n) => n.type === UnsavedDialog);
    expect(ask()!.props.name).toBe("a.ts");
    ask()!.props.onCancel();
    expect(fileTabs.get(A, "a.ts")).not.toBeNull();
    view.find((n) => n.type === TabStrip)!.props.onClose("file:a.ts");
    ask()!.props.onDiscard();
    expect(fileTabs.get(A, "a.ts")).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it("Save writes with the loaded hash, then closes", async () => {
    const api = createMockApi({});
    const write = vi.spyOn(api, "fileWrite").mockResolvedValue({ type: "saved", hash: "h2" });
    const live = (sessions = new Sessions(api));
    readyFile(A, "a.ts");
    fileTabs.edit(A, "a.ts", "changed");
    const view = harness(api, live);
    view.find((n) => n.type === TabStrip)!.props.onClose("file:a.ts");
    view.find((n) => n.type === UnsavedDialog)!.props.onSave();
    await tick();
    expect(write).toHaveBeenCalledWith(A, "a.ts", "changed", "lf", "h1");
    expect(fileTabs.get(A, "a.ts")).toBeNull();
  });

  it("Save that meets a conflict keeps the tab", async () => {
    const api = createMockApi({});
    vi.spyOn(api, "fileWrite").mockResolvedValue({ type: "conflict", diskHash: "zz" });
    const live = (sessions = new Sessions(api));
    readyFile(A, "a.ts");
    fileTabs.edit(A, "a.ts", "changed");
    const view = harness(api, live);
    view.find((n) => n.type === TabStrip)!.props.onClose("file:a.ts");
    view.find((n) => n.type === UnsavedDialog)!.props.onSave();
    await tick();
    expect(fileTabs.get(A, "a.ts")).toMatchObject({ conflict: "zz" });
  });

  it("the save key writes the shown file with its loaded hash; elsewhere it lets the key on", async () => {
    const api = createMockApi({});
    const write = vi.spyOn(api, "fileWrite").mockResolvedValue({ type: "saved", hash: "h2" });
    const live = (sessions = new Sessions(api));
    const none = harness(api, live);
    expect(handlers(none)["file.save"]!()).toBe(false);
    readyFile(A, "a.ts");
    fileTabs.edit(A, "a.ts", "changed");
    const view = harness(api, live);
    expect(handlers(view)["file.save"]!()).toBe(true);
    await tick();
    expect(write).toHaveBeenCalledWith(A, "a.ts", "changed", "lf", "h1");
    expect(fileTabs.get(A, "a.ts")).toMatchObject({ saved: "changed", hash: "h2" });
  });
});

it("a link menu request renders the menu with its title and closes on pick; the terminal gets the worktree", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const tab = live.open(A, "shell");
  const onLinkSettings = vi.fn();
  const view = harness(api, live, A, true, { onLinkSettings });
  const term = view.terminals().find((n) => n.props.id === tab.id)!;
  expect(term.props.worktree).toBe(A);
  expect(term.props.onLinkSettings).toBe(onLinkSettings);
  expect(menuOf(view)).toBeUndefined();
  const run = vi.fn();
  term.props.onLinkMenu({ x: 7, y: 8 }, [{ id: "open", labelKey: "termLink.open", run }], "src/a.ts:3");
  const menu = menuOf(view)!;
  expect(menu.props.at).toEqual({ x: 7, y: 8 });
  expect(menu.props.title).toBe("src/a.ts:3");
  expect(menu.props.items.map((i: { id: string }) => i.id)).toEqual(["open"]);
  menu.props.items[0].run();
  menu.props.onClose();
  expect(run).toHaveBeenCalledTimes(1);
  expect(menuOf(view)).toBeUndefined();
});

describe("markdown preview tabs", () => {
  beforeEach(() => fileTabs.reset());
  afterEach(() => fileTabs.reset());

  // One render and its effects: the layout the render derived is what the store keeps.
  const settle = (view: ReturnType<typeof harness>) => {
    vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {} });
    hooks.effects = [];
    view.draw();
    hooks.effects.forEach((effect) => effect());
    return view;
  };
  const tabsOf = (live: Sessions) => (leaves(live.layout(A)!) as Extract<PaneNode, { kind: "leaf" }>[]).map((n) => n.tabs);
  const open = (live: Sessions, rel: string, text = "# one") => {
    readyFile(A, rel, text);
    return settle(harness(createMockApi({}), live));
  };

  it("the preview key opens preview:<rel> in the same pane and shows the unsaved text", () => {
    const live = (sessions = new Sessions(createMockApi({})));
    const view = open(live, "docs/a.md");
    fileTabs.edit(A, "docs/a.md", "# two");
    expect(handlers(view)["file.markdownPreview"]!()).toBe(true);
    settle(view);
    expect(tabsOf(live)).toEqual([["file:docs/a.md", "preview:docs/a.md"]]);
    expect(view.find((n) => n.type === MarkdownPreview)!.props).toMatchObject({ rel: "docs/a.md", text: "# two" });
    const items = view.find((n) => n.type === TabStrip)!.props.items as { id: string; preview?: { rel: string } }[];
    expect(items.map((i) => i.id)).toEqual(["file:docs/a.md", "preview:docs/a.md"]);
    expect(items[1].preview).toEqual({ rel: "docs/a.md" });
  });

  it("the key declines for a file that is not Markdown and when no file is in front", () => {
    const live = (sessions = new Sessions(createMockApi({})));
    expect(handlers(settle(harness(createMockApi({}), live)))["file.markdownPreview"]!()).toBe(false);
    const view = open(live, "a.ts");
    expect(handlers(view)["file.markdownPreview"]!()).toBe(false);
    expect(tabsOf(live).flat()).toEqual(["file:a.ts"]);
  });

  it("Open preview to the side puts the preview in a new pane to the right", () => {
    const live = (sessions = new Sessions(createMockApi({})));
    const view = open(live, "a.md");
    const eye = view.find((n) => n.props.label === en("files.preview.side"))!;
    expect(eye.props.icon).toBe("eye");
    eye.props.onClick();
    expect(tabsOf(live)).toEqual([["file:a.md"], ["preview:a.md"]]);
    expect(live.layout(A)!.root).toMatchObject({ kind: "split", dir: "right" });
  });

  it("offers no side preview for a file that is not Markdown", () => {
    const live = (sessions = new Sessions(createMockApi({})));
    const view = open(live, "a.ts");
    expect(view.find((n) => n.props.label === en("files.preview.side"))).toBeUndefined();
  });

  it("closing the source closes the preview", () => {
    const live = (sessions = new Sessions(createMockApi({})));
    const view = open(live, "a.md");
    handlers(view)["file.markdownPreview"]!();
    settle(view);
    view.find((n) => n.type === TabStrip)!.props.onClose("file:a.md");
    expect(fileTabs.get(A, "a.md")).toBeNull();
    settle(view);
    expect(live.layout(A)).toBeNull();
    expect(view.find((n) => n.type === MarkdownPreview)).toBeUndefined();
  });

  it("closing the preview keeps the source", () => {
    const live = (sessions = new Sessions(createMockApi({})));
    const view = open(live, "a.md");
    handlers(view)["file.markdownPreview"]!();
    settle(view);
    view.find((n) => n.type === TabStrip)!.props.onClose("preview:a.md");
    settle(view);
    expect(tabsOf(live)).toEqual([["file:a.md"]]);
    expect(fileTabs.get(A, "a.md")).not.toBeNull();
  });

  it("drops a persisted preview id with no open file", () => {
    const live = (sessions = new Sessions(createMockApi({})));
    readyFile(A, "kept.md");
    live.setLayout(A, addTab(addTab(single("file:kept.md"), "preview:gone.md"), "preview:kept.md"));
    const view = settle(harness(createMockApi({}), live));
    settle(view);
    expect(tabsOf(live).flat()).toEqual(["file:kept.md", "preview:kept.md"]);
  });
});

it("a commit ask opens the commit tab, and a new one points it at another commit", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const view = harness(api, live, A, true, { commit: { id: "aaaaaaa1111", file: "a.ts", seq: 1 } });
  expect(selected(view)).toEqual(["commit:"]);
  expect(view.find((n) => n.type === CommitView)!.props.commit).toMatchObject({ id: "aaaaaaa1111", file: "a.ts" });
  expect(view.html()).toContain(en("commitView.tab", { id: "aaaaaaa" }));
  // Only one commit tab: the same id, pointed at the last commit asked for.
  const again = harness(api, live, A, true, { commit: { id: "bbbbbbb2222", file: null, seq: 2 } });
  expect(again.all().filter((n) => n.props["data-tab"] === "commit:" && n.props.role === "tab")).toHaveLength(1);
  expect(again.find((n) => n.type === CommitView)!.props.commit).toMatchObject({ id: "bbbbbbb2222", file: null });
});

it("ctrl_w_on_the_commit_tab_closes_it", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const view = harness(api, live, A, true, { commit: { id: "aaaaaaa1111", file: null, seq: 1 } });
  press(view, CTRL_W);
  expect(view.find((n) => n.props["data-tab"] === "commit:")).toBeUndefined();
});

it("a sleeping tab shows a Wake overlay in place of its terminal, and Wake starts it again", async () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const view = harness(api, live);
  const tab = live.open(A, "shell");
  const slept = (await live.hibernate(tab.id))!;
  expect(view.terminals()).toHaveLength(0);
  const html = view.html();
  expect(html).toContain(en("sleep.tab.title"));
  expect(html).toContain(en("sleep.wake"));
  // The overlay is an EmptyState; its action is the Wake button.
  const empty = view.find((n) => n.type === EmptyState)!;
  expect(empty.props.actions.props["data-field"]).toBe("wake");
  expect(empty.props.hint).toBe(en("sleep.tab.hint.shell"));
  empty.props.actions.props.onClick();
  expect(live.tabs(A)[0].asleep).toBeUndefined();
  // A wake takes a fresh pty id in the same slot.
  const [woken] = live.tabs(A);
  expect(woken.id).not.toBe(slept.id);
  expect(view.terminals().map((n) => n.props.id)).toEqual([woken.id]);
  expect(view.html()).not.toContain(en("sleep.tab.title"));
});
