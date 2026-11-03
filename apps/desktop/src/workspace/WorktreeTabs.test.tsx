import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi, toApiError, type Api, type PtyExit } from "../api";
import { translate } from "../i18n";
import { Terminal } from "../terminal/Terminal";
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
    useState: (initial: any) => (hooks.active ? state(initial) : react.useState(initial)),
    useEffect: (effect: any, deps?: any) => (hooks.active ? void hooks.effects.push(effect) : react.useEffect(effect, deps)),
    useCallback: (fn: any, deps: any) => (hooks.active ? fn : react.useCallback(fn, deps)),
    useSyncExternalStore: (subscribe: any, get: any, server?: any) => (hooks.active ? get() : react.useSyncExternalStore(subscribe, get, server)),
  };
});
vi.mock("../i18n", async (original) => ({ ...await original<typeof import("../i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));
// xterm needs a real canvas; `run` below does what the terminal does with its client.
vi.mock("../terminal/Terminal", () => ({ Terminal: () => null }));

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
beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false; });
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
  expect(approve).toHaveBeenCalledWith("claude");
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
