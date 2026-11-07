import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Banner, Button, EmptyState, IconButton, Menu, TabStrip, Textarea } from "@xdev-asia/ui";
import { translate } from "@/i18n";
import { createMockApi } from "@/mockApi";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
const st = vi.hoisted(() => ({ state: { open: true, tabs: [] as { id: string; kind: string; n: number }[], active: null as string | null } }));
const keys = vi.hoisted(() => ({ handlers: {} as Record<string, (e?: unknown) => unknown>, when: undefined as undefined | (() => boolean) }));
const store = vi.hoisted(() => ({
  addFloatingTab: vi.fn(),
  closeFloating: vi.fn(),
  closeFloatingTab: vi.fn(),
  selectFloatingTab: vi.fn(),
  stepFloatingTab: vi.fn(),
  focusInFloating: vi.fn(() => true),
  setFloatingCwd: vi.fn(),
  setNoteBody: vi.fn(() => true),
  forgetFloatingClient: vi.fn(),
}));
const browser = vi.hoisted(() => ({ entries: [] as { id: string; title: string | null }[] }));

vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [hooks.values[index], (v: unknown) => { hooks.values[index] = typeof v === "function" ? (v as (x: unknown) => unknown)(hooks.values[index]) : v; }];
    },
  };
});
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));
vi.mock("@/keys/keymap", async (original) => ({
  ...await original<typeof import("@/keys/keymap")>(),
  useKeymap: (h: Record<string, (e?: unknown) => unknown>, o?: { when?: () => boolean }) => { keys.handlers = h; keys.when = o?.when; },
}));
vi.mock("./floatingStore", async (original) => ({
  ...await original<typeof import("./floatingStore")>(),
  useFloating: () => st.state,
  floatingState: () => st.state,
  ...store,
}));
vi.mock("@/browser/browserTabs", async (original) => ({ ...await original<typeof import("@/browser/browserTabs")>(), useBrowserTabs: () => browser.entries }));
vi.mock("@/terminal/Terminal", () => ({ Terminal: () => null }));
vi.mock("@/browser/BrowserTab", () => ({ BrowserTab: () => null }));
vi.mock("@/files/MarkdownPane", () => ({ MarkdownPane: () => null }));

import { BrowserTab } from "@/browser/BrowserTab";
import { MarkdownPane } from "@/files/MarkdownPane";
import { Terminal } from "@/terminal/Terminal";
import { FLOATING_WORKTREE, clientOf } from "./floatingStore";
import { NOTE_MAX_TABS } from "./floatingSnapshot";
import { FloatingPanel } from "./FloatingPanel";

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const api = createMockApi({});
const draw = (home: string | null = "/home/demo", homeError: string | null = null) => {
  hooks.cursor = 0;
  return FloatingPanel({ api, home, homeError }) as Node;
};
const all = (home?: string | null, err?: string | null) => nodes(draw(home, err));

beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
  keys.handlers = {};
  Object.values(store).forEach((f) => f.mockClear());
  store.setNoteBody.mockReturnValue(true);
  st.state = { open: true, tabs: [], active: null };
  browser.entries = [];
});

const two = () => {
  st.state = { open: true, tabs: [{ id: "floating-term-1", kind: "terminal", n: 1 }, { id: "floating-term-2", kind: "terminal", n: 2 }], active: "floating-term-2" };
};

it("the root is a labelled region, hidden while closed", () => {
  const root = draw();
  expect(root.type).toBe("section");
  expect(root.props.className).toContain("floating-ws");
  expect(root.props.role).toBe("region");
  expect(root.props["aria-label"]).toBe(en("floating.title"));
  expect(root.props.hidden).toBe(false);
  st.state = { ...st.state, open: false };
  expect(draw().props.hidden).toBe(true);
});

it("the strip lists one item per tab", () => {
  st.state = { open: true, tabs: [{ id: "floating-term-1", kind: "terminal", n: 1 }, { id: "b1", kind: "browser", n: 2 }, { id: "b2", kind: "browser", n: 3 }, { id: "floating-note-x", kind: "note", n: 4 }], active: "b1" };
  browser.entries = [{ id: "b1", title: "Docs" }, { id: "b2", title: null }];
  const strip = all().find((n) => n.type === TabStrip)!;
  expect(strip.props.tabs.map((t: { name: string }) => t.name)).toEqual(["Terminal 1", "Docs", en("floating.tab.browser"), en("floating.tab.noteN", { n: 4 })]);
  expect(strip.props.selected).toBe("b1");
  strip.props.onSelect("b2");
  expect(store.selectFloatingTab).toHaveBeenCalledWith("b2");
  strip.props.onClose("b2");
  expect(store.closeFloatingTab).toHaveBeenCalledWith("b2");
});

it("add opens a menu of three kinds, each adds a tab", () => {
  st.state = { ...st.state, tabs: [{ id: "floating-term-1", kind: "terminal", n: 1 }], active: "floating-term-1" };
  expect(all().some((n) => n.type === Menu)).toBe(false);
  all().find((n) => n.type === TabStrip)!.props.onAdd();
  const menu = all().find((n) => n.type === Menu)!;
  expect(menu.props.items.map((i: { label: string }) => i.label)).toEqual([en("floating.new.terminal"), en("floating.new.browser"), en("floating.new.note")]);
  menu.props.items.forEach((i: { onSelect(): void }) => i.onSelect());
  expect(store.addFloatingTab.mock.calls).toEqual([["terminal"], ["browser"], ["note"]]);
  menu.props.onClose();
  expect(all().some((n) => n.type === Menu)).toBe(false);
});

it("every terminal tab stays mounted, the ones behind are hidden", () => {
  two();
  const terms = all().filter((n) => n.type === Terminal);
  expect(terms.map((n) => [n.props.id, n.props.cwd, n.props.profile])).toEqual([["floating-term-1", "/home/demo", "shell"], ["floating-term-2", "/home/demo", "shell"]]);
  terms.forEach((n) => expect(n.props.client).toBe(clientOf(n.props.id)));
  const panes = all().filter((n) => String(n.props?.className ?? "").includes("floating-ws-pane"));
  expect(panes.map((n) => n.props.hidden)).toEqual([true, false]);
});

it("waits for the home folder, and says when it cannot be found", () => {
  two();
  expect(all(null).some((n) => n.type === Terminal)).toBe(false);
  expect(all(null).some((n) => n.type === Banner)).toBe(false);
  const banner = all(null, "boom").find((n) => n.type === Banner)!;
  expect(banner.props.title).toBe(en("floating.homeFailed", { message: "boom" }));
});

it("a browser tab shows only when the panel is open and the tab is in front", () => {
  st.state = { open: true, tabs: [{ id: "b1", kind: "browser", n: 1 }], active: "b1" };
  browser.entries = [{ id: "b1", title: null }];
  expect(all().find((n) => n.type === BrowserTab)!.props.visible).toBe(true);
  st.state = { ...st.state, open: false };
  expect(all().find((n) => n.type === BrowserTab)!.props.visible).toBe(false);
  st.state = { open: true, tabs: [{ id: "b1", kind: "browser", n: 1 }, { id: "floating-term-2", kind: "terminal", n: 2 }], active: "floating-term-2" };
  expect(all().find((n) => n.type === BrowserTab)!.props.visible).toBe(false);
});

it("terminals start in their saved folder, and report the folder they move to", () => {
  st.state = { open: true, tabs: [{ id: "floating-term-1", kind: "terminal", n: 1, cwd: "/work" } as never, { id: "floating-term-2", kind: "terminal", n: 2 }], active: "floating-term-1" };
  const terms = all().filter((n) => n.type === Terminal);
  expect(terms.map((n) => n.props.cwd)).toEqual(["/work", "/home/demo"]);
  terms[0].props.onCwd("/work/sub");
  expect(store.setFloatingCwd).toHaveBeenCalledWith("floating-term-1", "/work/sub");
});

it("a restored terminal that fails in its saved folder retries once in home, with a banner", () => {
  st.state = { open: true, tabs: [{ id: "floating-term-1", kind: "terminal", n: 1, cwd: "/gone" } as never], active: "floating-term-1" };
  const first = all().find((n) => n.type === Terminal)!;
  first.props.onError({ code: "io", detail: "no such dir" });
  expect(store.forgetFloatingClient).toHaveBeenCalledWith("floating-term-1");
  const rows = all();
  const second = rows.find((n) => n.type === Terminal)!;
  expect(second.props.cwd).toBe("/home/demo");
  expect(second.key).not.toBe(first.key);
  const banners = rows.filter((n) => n.type === Banner);
  expect(banners.map((b) => b.props.title)).toEqual([en("floating.cwdGone")]);
  expect(banners[0].props.tone).toBe("info");
  // A second error is not retried: it is shown.
  store.forgetFloatingClient.mockClear();
  second.props.onError({ code: "io", detail: "still no" });
  expect(store.forgetFloatingClient).not.toHaveBeenCalled();
  expect(all().some((n) => n.type === Banner && n.props.title === en("floating.terminalFailed", { message: "still no" }))).toBe(true);
});

it("a failure with no saved folder is shown, not retried", () => {
  st.state = { open: true, tabs: [{ id: "floating-term-1", kind: "terminal", n: 1 }], active: "floating-term-1" };
  all().find((n) => n.type === Terminal)!.props.onError({ code: "io", detail: "boom" });
  expect(store.forgetFloatingClient).not.toHaveBeenCalled();
  expect(all().some((n) => n.type === Banner && n.props.title === en("floating.terminalFailed", { message: "boom" }))).toBe(true);
});

const notes = (n: number) => {
  const tabs = Array.from({ length: n }, (_, i) => ({ id: `floating-note-${i + 1}`, kind: "note", n: i + 1, body: `body ${i + 1}` }));
  st.state = { open: true, tabs, active: tabs[0].id };
};

it("each note tab is a Markdown pane over a labelled textarea that saves to the store", () => {
  notes(2);
  const panes = all().filter((n) => n.type === MarkdownPane);
  expect(panes.map((p) => p.props.rel)).toEqual(["note-1.md", "note-2.md"]);
  expect(panes.map((p) => p.props.text)).toEqual(["body 1", "body 2"]);
  expect(panes[0].props.worktree).toBe(FLOATING_WORKTREE);
  const area = nodes(panes[1].props.source).find((n) => n.type === Textarea)!;
  expect(area.props.label).toBe(en("floating.tab.noteN", { n: 2 }));
  expect(area.props.value).toBe("body 2");
  area.props.onChange({ target: { value: "new" } });
  expect(store.setNoteBody).toHaveBeenCalledWith("floating-note-2", "new");
  expect(all().some((n) => n.type === Banner)).toBe(false);
});

it("a refused note change shows the too long banner until the next accepted one", () => {
  notes(1);
  store.setNoteBody.mockReturnValue(false);
  nodes(all().find((n) => n.type === MarkdownPane)!.props.source).find((n) => n.type === Textarea)!.props.onChange({ target: { value: "huge" } });
  const banner = all().find((n) => n.type === Banner)!;
  expect(banner.props.title).toBe(en("floating.noteTooLong"));
  expect(banner.props.tone).toBe("warn");
  store.setNoteBody.mockReturnValue(true);
  nodes(all().find((n) => n.type === MarkdownPane)!.props.source).find((n) => n.type === Textarea)!.props.onChange({ target: { value: "ok" } });
  expect(all().some((n) => n.type === Banner)).toBe(false);
});

it("at 8 notes the note menu item is disabled and carries the limit hint", () => {
  notes(NOTE_MAX_TABS - 1);
  all().find((n) => n.type === TabStrip)!.props.onAdd();
  let note = all().find((n) => n.type === Menu)!.props.items[2];
  expect(note.disabled).toBeUndefined();
  notes(NOTE_MAX_TABS);
  note = all().find((n) => n.type === Menu)!.props.items[2];
  expect(note.disabled).toBe(true);
  expect(note.label).toContain(en("floating.noteLimit", { max: NOTE_MAX_TABS }));
  expect(note.onSelect).toBeUndefined();
});

it("the close button closes the panel", () => {
  const btn = all().find((n) => n.type === IconButton)!;
  expect(btn.props.label).toBe(en("floating.close"));
  btn.props.onClick();
  expect(store.closeFloating).toHaveBeenCalled();
});

it("the empty state has the one primary button", () => {
  const empty = all().find((n) => n.type === EmptyState)!;
  expect(empty).toBeTruthy();
  const primary = nodes(empty.props.actions).filter((n) => n.type === Button && n.props.variant === "primary");
  expect(primary).toHaveLength(1);
  expect(primary[0].props.children).toBe(en("floating.empty.cta"));
  primary[0].props.onClick();
  expect(store.addFloatingTab).toHaveBeenCalledWith("terminal");
  two();
  expect(all().some((n) => n.type === EmptyState || (n.type === Button && n.props.variant === "primary"))).toBe(false);
});

it("the tab keys act on the panel tabs, only with focus inside an open panel", () => {
  two();
  draw();
  keys.handlers["tab.new"]();
  expect(store.addFloatingTab).toHaveBeenCalledWith("terminal");
  keys.handlers["tab.close"]();
  expect(store.closeFloatingTab).toHaveBeenCalledWith("floating-term-2");
  keys.handlers["tab.next"]();
  expect(store.stepFloatingTab).toHaveBeenCalledWith(1);
  keys.handlers["tab.prev"]();
  expect(store.stepFloatingTab).toHaveBeenCalledWith(-1);
  expect(keys.when!()).toBe(true);
  store.focusInFloating.mockReturnValueOnce(false);
  expect(keys.when!()).toBe(false);
  st.state = { ...st.state, open: false };
  expect(keys.when!()).toBe(false);
});
