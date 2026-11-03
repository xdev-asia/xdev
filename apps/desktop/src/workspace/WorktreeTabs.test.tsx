import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi, toApiError, type Api, type Profile, type ProfilesView, type PtyExit } from "@/api";
import { translate } from "@/i18n";
import { Terminal } from "@/terminal/Terminal";
import { AgentIcon } from "./AgentIcon";
import { Sessions } from "./sessions";
import { addTab, leaves, paneOf, removeTab, resize, selectTab, splitPane, toggleExpand, type PaneLayout, type PaneNode } from "./paneTree";
import { PaneView } from "./PaneView";
import { TabStrip } from "./TabStrip";
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

function harness(api: Api, sessions: Sessions, worktree = A, visible = true) {
  const values: unknown[] = [];
  const draw = () => {
    hooks.values = values;
    hooks.cursor = 0;
    hooks.active = true;
    try { return WorktreeTabs({ api, sessions, worktree, visible }); } finally { hooks.active = false; }
  };
  const drawFull = () => {
    hooks.values = values;
    hooks.cursor = 0;
    hooks.active = true;
    try { return expand(WorktreeTabs({ api, sessions, worktree, visible })); } finally { hooks.active = false; }
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
beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false; store.view = null; });
afterEach(() => { sessions?.dispose(); sessions = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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

function contextMenu(view: ReturnType<typeof harness>, id: string) {
  const tab = view.all().find((n) => n.props.className === "ws-tab" && nodes(n.props.children).some((c) => c.props["data-tab"] === id))!;
  tab.props.onContextMenu({ preventDefault() {}, clientX: 10, clientY: 20 });
  return (label: string) => view.find((n) => n.props.role === "menuitem" && n.props.children === label)!;
}

it("a tab context menu offers close, close others, split, rename", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const one = live.open(A, "shell");
  live.open(A, "claude");
  const view = harness(api, live);
  const item = contextMenu(view, one.id);
  expect(view.find((n) => n.props.role === "menu")!.props.style).toMatchObject({ left: 10, top: 20 });
  expect(["workspace.tabs.split.right", "workspace.tabs.split.down", "panes.menu.closeOthers", "panes.menu.rename"].map((k) => item(en(k)))).toHaveLength(4);
  expect(item(en("workspace.tabs.close", { name: en("terminal.profile.shell") }))).toBeDefined();
});

it("context menu close and close others call Sessions.close", async () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const one = live.open(A, "shell");
  const two = live.open(A, "claude");
  const three = live.open(A, "codex");
  const close = vi.spyOn(live, "close");
  const view = harness(api, live);
  contextMenu(view, two.id)(en("workspace.tabs.close", { name: en("terminal.profile.claude") })).props.onClick();
  expect(close).toHaveBeenCalledWith(two.id);
  await tick();
  close.mockClear();
  contextMenu(view, one.id)(en("panes.menu.closeOthers")).props.onClick();
  expect(close.mock.calls.map((c) => c[0])).toEqual([three.id]);
  // The menu closes once an item ran.
  expect(view.find((n) => n.props.role === "menu")).toBeUndefined();
});

it("context menu split moves the tab into a new pane; a pane's only tab cannot split", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const one = live.open(A, "shell");
  const two = live.open(A, "claude");
  const view = harness(api, live);
  contextMenu(view, one.id)(en("workspace.tabs.split.down")).props.onClick();
  const l = live.layout(A)!;
  expect(leaves(l)).toHaveLength(2);
  expect((l.root as Extract<PaneNode, { kind: "split" }>).dir).toBe("down");
  expect(l.focused).toBe(paneOf(l, one.id));
  expect(paneOf(l, one.id)).not.toBe(paneOf(l, two.id));
  // Each pane has one tab now: nothing to split off, nothing to close.
  const before = live.layout(A);
  const item = contextMenu(view, two.id);
  expect(item(en("workspace.tabs.split.right")).props["aria-disabled"]).toBe(true);
  expect(item(en("panes.menu.closeOthers")).props["aria-disabled"]).toBe(true);
  item(en("workspace.tabs.split.right")).props.onClick();
  expect(live.layout(A)).toBe(before);
});

it("context menu rename names the tab by hand", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const tab = live.open(A, "shell");
  const view = harness(api, live);
  contextMenu(view, tab.id)(en("panes.menu.rename")).props.onClick();
  const input = view.find((n) => n.type === "input" && n.props["aria-label"] === en("panes.rename"))!;
  input.props.onKeyDown({ key: "Enter", currentTarget: { value: "  build  " } });
  expect(live.tabs(A)[0]).toMatchObject({ title: "build", renamed: true });
  // Escape leaves the name alone.
  contextMenu(view, tab.id)(en("panes.menu.rename")).props.onClick();
  view.find((n) => n.type === "input")!.props.onKeyDown({ key: "Escape", currentTarget: { value: "zzz" } });
  expect(live.tabs(A)[0].title).toBe("build");
  expect(view.find((n) => n.type === "input")).toBeUndefined();
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
  shown.press({ altKey: false });
  shown.press({ key: "y", code: "KeyY" });
  expect(live.tabs(A)).toEqual([]);
  const e = shown.press();
  expect(e.preventDefault).toHaveBeenCalled();
  expect(live.tabs(A).map((t) => t.profileId)).toEqual(["codex"]);
  expect(live.tabs(B)).toEqual([]);

  shown.cleanup();
  expect(shown.listeners.size).toBe(0);
});
