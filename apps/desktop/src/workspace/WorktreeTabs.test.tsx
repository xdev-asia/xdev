import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi, toApiError, type Api, type Profile, type ProfilesView, type PtyExit } from "@/api";
import { translate } from "@/i18n";
import { Terminal } from "@/terminal/Terminal";
import { AgentIcon } from "./AgentIcon";
import { Sessions } from "./sessions";
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
  const all = () => nodes(draw());
  const html = () => renderToStaticMarkup(draw());
  const find = (pick: (n: Node) => boolean) => all().find(pick);
  const labelled = (label: string) => find((n) => n.props["aria-label"] === label && n.props.onClick)!;
  const button = (text: string) => find((n) => n.type === "button" && n.props.children === text)!;
  const terminals = () => all().filter((n) => n.type === Terminal);
  const dialog = () => find((n) => typeof n.props.onConfirm === "function")!;
  return { draw, all, html, find, labelled, button, terminals, dialog };
}

// What the terminal does on mount: start its tab's client, report the outcome.
async function run(term: Node) {
  await term.props.client
    .start(term.props.cwd, term.props.profile, 80, 24, () => {})
    .then(term.props.onStarted, (e: unknown) => term.props.onError(toApiError(e)));
}

let sessions: Sessions | null = null;
beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false; store.view = null; });
afterEach(() => { sessions?.dispose(); sessions = null; vi.restoreAllMocks(); });

it("plus menu starts claude in the worktree after approval", async () => {
  const api = createMockApi({});
  const approve = vi.spyOn(api, "ptyApprove");
  const spawn = vi.spyOn(api, "ptySpawn");
  const live = (sessions = new Sessions(api));
  const view = harness(api, live);
  view.labelled(en("workspace.tabs.new")).props.onClick();
  view.find((n) => n.props.role === "menuitem" && n.props.children === en("terminal.profile.claude"))!.props.onClick();
  const [tab] = live.tabs(A);
  expect(tab).toMatchObject({ worktree: A, profileId: "claude" });
  // The menu closes once something is picked.
  expect(view.find((n) => n.props.role === "menu")).toBeUndefined();

  const first = view.terminals()[0];
  expect(first.props).toMatchObject({ id: tab.id, cwd: A, profile: "claude", client: tab.client });
  await run(first);
  expect(view.dialog().props.open).toBe(true);
  expect(view.dialog().props.body).toContain("start claude in a terminal");

  view.dialog().props.onConfirm();
  await tick();
  expect(approve).toHaveBeenCalledWith("claude", null);
  const second = view.terminals()[0];
  // A fresh view on the same tab and pty id.
  expect(second.key).not.toBe(first.key);
  expect(second.props.client).toBe(tab.client);
  await run(second);
  expect(spawn).toHaveBeenCalledTimes(2);
  expect(spawn.mock.calls[1].slice(0, 3)).toEqual([tab.id, A, "claude"]);
  expect(approve.mock.invocationCallOrder[0]).toBeLessThan(spawn.mock.invocationCallOrder[1]);
  expect(view.dialog().props.open).toBe(false);
  expect(live.tabs(A)).toHaveLength(1);
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
  expect(view.html()).toContain("○");
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
  expect(html).toContain("✕");

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

// The panes of the split: the container and which tab panes are showing.
function layout(view: ReturnType<typeof harness>) {
  const panes = view.find((n) => n.type === "div" && n.props.className === "ws-panes")!;
  const shownIds = view.all().filter((n) => n.props.role === "tabpanel" && !n.props.hidden).map((n) => n.props["data-tab"]);
  return { dir: panes.props["data-split"] as string | undefined, shownIds };
}
const clickSplit = (view: ReturnType<typeof harness>, dir: "right" | "down") => view.labelled(en(`workspace.tabs.split.${dir}`)).props.onClick();
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
    const glyph = inside.find((n) => n.props.role === "img")!;
    expect(glyph.props["aria-label"]).toBe(en("workspace.tabs.status.idle"));
  }
  const html = view.html();
  // The mark is decoration: the name next to it says the same.
  expect(html).toContain('class="ws-agent" data-profile="claude"');
  for (const letter of ["C", "X", "S"]) expect(html).toContain(`>${letter}</span>`);
  expect(html.split("○")).toHaveLength(4);
});

it("split right shows the active tab and the next tab side by side", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const one = live.open(A, "shell");
  const two = live.open(A, "claude");
  const three = live.open(A, "codex");
  const view = harness(api, live);
  pickTab(view, one.id);
  expect(layout(view)).toEqual({ dir: undefined, shownIds: [one.id] });

  clickSplit(view, "right");
  expect(live.split(A)).toEqual({ dir: "right", second: two.id });
  expect(layout(view)).toEqual({ dir: "right", shownIds: [one.id, two.id] });
  // Every terminal stays mounted; the third only hides.
  expect(view.terminals().map((n) => n.props.id)).toEqual([one.id, two.id, three.id]);
  expect(view.find((n) => n.props["data-tab"] === three.id && n.props.role === "tabpanel")!.props.hidden).toBe(true);
  expect(view.labelled(en("workspace.tabs.split.right")).props["aria-pressed"]).toBe(true);

  // Picking another tab brings it in beside the second.
  pickTab(view, three.id);
  expect(layout(view)).toEqual({ dir: "right", shownIds: [two.id, three.id] });
  // Picking the second keeps the pair.
  pickTab(view, two.id);
  expect(layout(view).shownIds).toEqual([two.id, three.id]);
});

it("split down stacks them", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const one = live.open(A, "shell");
  const two = live.open(A, "claude");
  const view = harness(api, live);
  // The newest tab shows, so its partner is the one before it.
  clickSplit(view, "down");
  expect(live.split(A)).toEqual({ dir: "down", second: one.id });
  expect(layout(view)).toEqual({ dir: "down", shownIds: [one.id, two.id] });
  // Turning it the other way keeps the two tabs.
  clickSplit(view, "right");
  expect(live.split(A)).toEqual({ dir: "right", second: one.id });
  expect(layout(view)).toEqual({ dir: "right", shownIds: [one.id, two.id] });
});

it("split again with the same direction unsplits", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  live.open(A, "shell");
  live.open(A, "claude");
  const view = harness(api, live);
  clickSplit(view, "right");
  expect(live.split(A)).not.toBeNull();
  clickSplit(view, "right");
  expect(live.split(A)).toBeNull();
  expect(layout(view).dir).toBeUndefined();
  expect(layout(view).shownIds).toHaveLength(1);
  expect(view.labelled(en("workspace.tabs.split.right")).props["aria-pressed"]).toBe(false);
});

it("closing the second tab of a split unsplits", async () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const one = live.open(A, "shell");
  const two = live.open(A, "claude");
  live.open(A, "codex");
  const view = harness(api, live);
  pickTab(view, one.id);
  clickSplit(view, "right");
  expect(live.split(A)?.second).toBe(two.id);
  await live.close(two.id);
  expect(live.split(A)).toBeNull();
  expect(layout(view).dir).toBeUndefined();
  expect(layout(view).shownIds).toEqual([one.id]);
});

it("a split with one tab is disabled", () => {
  const api = createMockApi({});
  const live = (sessions = new Sessions(api));
  const view = harness(api, live);
  // No tab at all, then one.
  for (const dir of ["right", "down"] as const) expect(view.labelled(en(`workspace.tabs.split.${dir}`)).props["aria-disabled"]).toBe(true);
  live.open(A, "shell");
  for (const dir of ["right", "down"] as const) {
    expect(view.labelled(en(`workspace.tabs.split.${dir}`)).props["aria-disabled"]).toBe(true);
    clickSplit(view, dir);
  }
  expect(live.split(A)).toBeNull();
  expect(layout(view).dir).toBeUndefined();
  // Every button carries a tooltip.
  expect(view.labelled(en("workspace.tabs.split.right")).props.title).toBe(en("workspace.tabs.split.right"));
  live.open(A, "claude");
  expect(view.labelled(en("workspace.tabs.split.right")).props["aria-disabled"]).toBe(false);
});

const custom = (over: Partial<Profile> = {}): Profile => ({
  id: "aider", name: "Aider", cli: null, program: "aider", args: [], env: [], model: null, effort: null,
  permissions: null, account: null, startup: [], enabled: true, ...over,
});
const profileOf = async (api: Api, id: string) => (await api.profiles()).profiles.find((p) => p.profile.id === id)!.profile;
const openMenu = (view: ReturnType<typeof harness>) => view.labelled(en("workspace.tabs.new")).props.onClick();
const group = (view: ReturnType<typeof harness>, label: string) => view.find((n) => n.props.role === "group" && n.props["aria-label"] === label);
const items = (g: Node | undefined) => (g ? nodes(g.props.children).filter((n) => n.props.role === "menuitem").map((n) => n.props.children) : []);

it("plus_menu_lists_agents_and_shells", async () => {
  const api = createMockApi({});
  // Gemini is not installed in the mock; codex is turned off here.
  store.view = await api.profilePut({ ...(await profileOf(api, "codex")), enabled: false });
  const live = (sessions = new Sessions(api));
  const view = harness(api, live);
  openMenu(view);
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
  openMenu(view);
  view.find((n) => n.props.role === "menuitem" && n.props.children === "WSL Ubuntu")!.props.onClick();
  const [tab] = live.tabs(A);
  expect(tab).toMatchObject({ worktree: A, profileId: "shell:wsl:Ubuntu", agent: false });
  expect(view.find((n) => n.props.role === "menu")).toBeUndefined();
  await run(view.terminals()[0]);
  expect(spawn.mock.calls[0].slice(0, 3)).toEqual([tab.id, A, "shell:wsl:Ubuntu"]);
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
  openMenu(view);
  expect(items(group(view, en("workspace.tabs.agents")))).toContain("Aider");
  view.find((n) => n.props.role === "menuitem" && n.props.children === "Aider")!.props.onClick();
  const [tab] = live.tabs(A);
  expect(tab.profileId).toBe("aider");
  const html = view.html();
  expect(html).toContain("<span>Aider</span>");
  expect(html).toContain(">A</span>");
  expect(view.labelled(en("workspace.tabs.close", { name: "Aider" }))).toBeDefined();

  // Once the profile is gone the tab falls back to its id.
  store.view = await api.profileRemove("aider");
  expect(view.html()).toContain("<span>aider</span>");
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
  expect(view.html()).toContain(`<span>${en("terminal.profile.codex")}</span>`);
  view.find((n) => n.type === "button" && n.props.className === "ws-tab-again")!.props.onClick();
  await run(view.terminals()[0]);
  await tick();
  const banner = view.find((n) => n.props.role === "alert")!;
  expect(renderToStaticMarkup(banner)).toContain(en("error.profile_off"));
  // The failed start leaves nothing behind but the banner.
  expect(live.tabs(A)).toEqual([]);
});
