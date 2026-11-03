import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { translate } from "@/i18n";
import type { ProfilesView, ReviewNote } from "@/api";
import type { Sessions, Tab } from "@/workspace/sessions";
import type { TabStatus } from "@/workspace/status";
import { pastePrompt } from "@/workspace/agentPrompt";
import { newNote, notesPrompt, notesToSend } from "./notes";
import { SendNotesMenu } from "./SendNotesMenu";

const profiles = vi.hoisted(() => ({ view: null as unknown }));
vi.mock("@/agents/profileStore", async (original) => ({ ...(await original<typeof import("@/agents/profileStore")>()), useProfiles: () => ({ view: profiles.view, update() {}, reload: async () => {} }) }));
const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0, effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => {
    const index = hooks.cursor++;
    const values = hooks.values;
    if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
    return { index, values };
  };
  const state = (initial: unknown) => {
    const { index, values } = slot(initial);
    return [values[index], (value: unknown) => { values[index] = typeof value === "function" ? value(values[index]) : value; }];
  };
  return {
    ...react,
    // The profile store is outside what these tests render; its context keeps the default.
    useContext: (ctx: { _currentValue: unknown }) => ctx._currentValue,
    useState: (initial: any) => (hooks.active ? state(initial) : react.useState(initial)),
    useRef: (initial: any) => {
      if (!hooks.active) return react.useRef(initial);
      const { index, values } = slot(() => ({ current: initial }));
      return values[index];
    },
    useEffect: (effect: any, deps?: any) => (hooks.active ? void hooks.effects.push(effect) : react.useEffect(effect, deps)),
    useCallback: (fn: any, deps: any) => (hooks.active ? fn : react.useCallback(fn, deps)),
    useSyncExternalStore: (subscribe: any, get: any, server?: any) => (hooks.active ? get() : react.useSyncExternalStore(subscribe, get, server)),
  };
});
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));
type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const OAK = "/demo/wt/xdev-oak";
const START = "5555555555555555555555555555555555555555";
// Calls `render` with its own hook values; the first draw's effects run once, as on mount.
function mount(render: () => unknown) {
  const values: unknown[] = [];
  const draw = () => {
    hooks.values = values;
    hooks.cursor = 0;
    hooks.active = true;
    try { return render(); } finally { hooks.active = false; }
  };
  const before = hooks.effects.length;
  draw();
  const cleanups = hooks.effects.slice(before).map((effect) => effect());
  const all = () => nodes(draw());
  const html = () => renderToStaticMarkup(draw() as ReactElement);
  const find = (pick: (n: Node) => boolean) => all().find(pick);
  return { draw, all, html, find, cleanups };
}

const tab = (id: string, over: Partial<Tab> = {}): Tab => ({ id, worktree: OAK, profileId: "claude", account: null, permissions: "ask", agent: true, status: "idle", client: { input: vi.fn(async () => {}) } as never, ...over });
const notes: ReviewNote[] = [
  newNote("a.ts", 1, 1, "x", "first", 1, "n1"),
  { ...newNote("b.ts", 2, 2, "y", "second", 2, "n2"), sentAt: 9 },
];

function fake(initial: Tab[]) {
  let tabs = initial;
  const listeners = new Set<() => void>();
  const opened = tab("new", { status: "launching" as TabStatus });
  const sessions = {
    tabs: () => tabs,
    open: vi.fn(() => ((tabs = [...tabs, opened]), opened)),
    subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
  };
  const set = (status: TabStatus) => {
    tabs = tabs.map((t) => (t.id === "new" ? { ...t, status } : t));
    for (const l of [...listeners]) l();
  };
  return { sessions: sessions as unknown as Sessions, open: sessions.open, opened, set };
}

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false; profiles.view = null; });
afterEach(() => vi.useRealTimers());

function menu(sessions: Sessions | null, markSent = vi.fn(async () => {}), list = notes) {
  const m = mount(() => SendNotesMenu({ sessions, worktree: OAK, branch: "oak", notes: list, markSent }));
  const button = () => m.all().find((n) => n.props["aria-haspopup"] === "menu")!;
  const items = () => m.all().filter((n) => n.props.role === "menuitem");
  return { ...m, markSent, button, items, openMenu: () => button().props.onClick() };
}

it("counts the notes not sent yet and offers the sent ones on request", () => {
  const f = fake([tab("a")]);
  const m = menu(f.sessions);
  expect(m.html()).toContain(en("review.send.one", { count: 1 }));
  m.openMenu();
  m.all().find((n) => n.type === "input")!.props.onChange();
  expect(m.html()).toContain(en("review.send", { count: 2 }));
});

it("is disabled with nothing to send or no sessions", () => {
  const f = fake([tab("a")]);
  expect(menu(f.sessions, undefined, []).button().props.disabled).toBe(true);
  expect(menu(f.sessions, undefined, [notes[1]]).button().props.disabled).toBe(true);
  expect(menu(null).button().props.disabled).toBe(true);
  expect(menu(f.sessions).button().props.disabled).toBe(false);
});

it("lists the running agent tabs and a new tab for each agent that is on and installed", () => {
  profiles.view = {
    profiles: [
      { profile: { id: "claude", name: "Claude", enabled: true }, installed: true },
      { profile: { id: "codex", name: "Codex", enabled: true }, installed: false },
      { profile: { id: "gemini", name: "Gemini", enabled: false }, installed: true },
    ],
    shells: [],
  } as unknown as ProfilesView;
  const f = fake([tab("a"), tab("sh", { agent: false, profileId: "shell" }), tab("dead", { status: "exited" }), tab("b", { profileId: "codex" })]);
  const m = menu(f.sessions);
  m.openMenu();
  expect(m.items().map((n) => n.props["data-tab"] ?? `new:${n.props["data-new"]}`)).toEqual(["a", "b", "new:claude"]);
});

it("sends the prompt to the chosen tab once, then marks those notes sent", async () => {
  const a = tab("a");
  const f = fake([a]);
  const m = menu(f.sessions);
  m.openMenu();
  m.items().find((n) => n.props["data-tab"] === "a")!.props.onClick();
  await tick();
  expect(a.client.input).toHaveBeenCalledTimes(1);
  expect(a.client.input).toHaveBeenCalledWith(pastePrompt(notesPrompt("oak", notesToSend(notes, false))));
  expect(m.markSent).toHaveBeenCalledWith(["n1"]);
});

it("a new tab waits until it has started, then gets the prompt", async () => {
  vi.useFakeTimers();
  const f = fake([]);
  const m = menu(f.sessions);
  m.openMenu();
  m.items().find((n) => n.props["data-new"] === "claude")!.props.onClick();
  expect(f.open).toHaveBeenCalledWith(OAK, "claude");
  f.set("working");
  await vi.advanceTimersByTimeAsync(500);
  expect(f.opened.client.input).not.toHaveBeenCalled();
  f.set("idle");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.opened.client.input).toHaveBeenCalledTimes(1);
  expect(m.markSent).toHaveBeenCalledWith(["n1"]);
});

it("a new tab that never gets ready marks nothing and says so", async () => {
  vi.useFakeTimers();
  const f = fake([]);
  const m = menu(f.sessions);
  m.openMenu();
  m.items().find((n) => n.props["data-new"] === "claude")!.props.onClick();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(f.opened.client.input).not.toHaveBeenCalled();
  expect(m.markSent).not.toHaveBeenCalled();
  expect(m.html()).toContain(en("review.send.failed"));
});
