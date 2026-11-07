import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { PaletteRow } from "@xdev-asia/ui";
import { renderToStaticMarkup } from "react-dom/server";
import { translate } from "@/i18n";
import type { PaletteItem } from "./items";
import { JumpPalette, type JumpPaletteProps } from "./JumpPalette";
import { RecentStore } from "./recent";

const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const state = (initial: unknown) => {
    const index = hooks.cursor++;
    const slots = hooks.values;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
    return [slots[index], (value: unknown) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
  };
  return {
    ...react,
    useState: (initial: any) => (hooks.active ? state(initial) : react.useState(initial)),
    useEffect: (effect: any, deps?: any) => (hooks.active ? void hooks.effects.push(effect) : react.useEffect(effect, deps)),
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
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false; });

const run = vi.fn();
const mk = (id: string, kind: PaletteItem["kind"], title: string, extra: Partial<PaletteItem> = {}): PaletteItem => ({ id, kind, title, run: () => run(id), ...extra });
const items = [
  mk("tab:p1", "tab", "claude", { detail: "xdev / oak", status: "needs-you", order: 0 }),
  mk("wt:/wt/oak", "worktree", "oak", { detail: "xdev · feat/oak", worktree: "/wt/oak" }),
  mk("wt:/wt/elm", "worktree", "elm", { worktree: "/wt/elm" }),
  mk("set:agents", "setting", "Agents"),
  mk("act:newWorktree", "action", "New worktree"),
];


type Pal = {
  sections: { title: string; rows: PaletteRow[] }[];
  activeId: string;
  query: string;
  scope: string;
  scopes: { value: string; label: string }[];
  filter: boolean;
  inputAddon?: ReactElement<Record<string, any>>;
  onInputKeyDown(e: unknown): void;
  onActiveChange(id: string): void;
  onSelect(row: PaletteRow): void;
  onQueryChange(q: string): void;
  onScopeChange(v: string): void;
  onClose(): void;
  labels: Record<string, string>;
  title: string;
};

function setup(over: Partial<JumpPaletteProps> = {}) {
  const props: JumpPaletteProps = { open: true, items, current: { worktree: null, tab: null }, recent: new RecentStore(null, () => 1), canCreate: false, onCreate: vi.fn(), onClose: vi.fn(), now: 10, ...over };
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return JumpPalette(props) as Node; } finally { hooks.active = false; }
  };
  draw();
  hooks.effects.splice(0).forEach((e) => e());
  const pal = () => (draw().props.children as Node).props as unknown as Pal;
  const key = (init: Record<string, unknown>) => {
    const e: Record<string, any> = { key: "", ctrlKey: false, metaKey: false, shiftKey: false, keyCode: 0, nativeEvent: { isComposing: false }, defaultPrevented: false, stopPropagation: vi.fn(), ...init };
    e.preventDefault = vi.fn(() => { e.defaultPrevented = true; });
    pal().onInputKeyDown(e);
    return e;
  };
  // What the design system palette does with a key the app leaves alone.
  const nav = (k: string) => {
    const e = key({ key: k });
    if (e.defaultPrevented) return e;
    const flat = pal().sections.flatMap((x) => x.rows);
    const at = Math.max(0, flat.findIndex((r) => r.id === pal().activeId));
    const next = k === "ArrowDown" ? (at + 1) % flat.length : k === "ArrowUp" ? (at - 1 + flat.length) % flat.length : k === "Home" ? 0 : k === "End" ? flat.length - 1 : null;
    if (next !== null) pal().onActiveChange(flat[next].id!);
    if (k === "Enter" && flat[at]) pal().onSelect(flat[at]);
    return e;
  };
  const type = (value: string) => pal().onQueryChange(value);
  const html = () => renderToStaticMarkup(draw());
  const rows = () => pal().sections.flatMap((x) => x.rows);
  const ids = () => rows().map((r) => r.id);
  const addon = () => pal().inputAddon;
  const parts = () => nodes(addon());
  const filterBtn = () => parts().find((n) => n.props.className === "pal-filter-btn")!;
  const menuItems = () => parts().filter((n) => n.props.role === "menuitemradio");
  const hasMenu = () => parts().some((n) => n.props.role === "menu");
  return { props, draw, pal, key, nav, type, html, rows, ids, addon, parts, filterBtn, menuItems, hasMenu };
}

it("titled Jump to and lists recent rows on open", () => {
  const p = setup();
  const html = p.html();
  expect(html).toContain("Jump to…");
  expect(html).toContain(en("palette.section.recentTabs"));
  expect(html).toContain(en("palette.section.recentWorktrees"));
  expect(p.rows()).toHaveLength(3);
  // The app ranks; the palette shows the rows as given.
  expect(p.pal().filter).toBe(false);
});

it("typing filters and highlights hits", () => {
  const p = setup();
  p.type("oa");
  const html = p.html();
  expect(html).toContain('<b class="pal-hit">oa</b>');
  expect(html).not.toContain(">elm<");
});

it("arrow keys wrap and enter runs the selected row then closes", () => {
  run.mockReset();
  const p = setup();
  p.nav("ArrowUp");
  p.nav("Enter");
  expect(run).toHaveBeenCalledWith("wt:/wt/oak");
  expect(p.props.onClose).toHaveBeenCalled();
  const q = setup();
  q.nav("End");
  q.nav("ArrowDown");
  q.nav("Enter");
  expect(run).toHaveBeenLastCalledWith("tab:p1");
});

it("the first row is active and typing resets it", () => {
  const p = setup();
  expect(p.pal().activeId).toBe("tab:p1");
  p.nav("End");
  expect(p.pal().activeId).toBe("wt:/wt/oak");
  p.type("o");
  expect(p.pal().activeId).toBe(p.ids()[0]);
});

it("escape closes through the palette", () => {
  const p = setup();
  p.pal().onClose();
  expect(p.props.onClose).toHaveBeenCalled();
});

it("tab and shift+tab cycle the kind scope", () => {
  const p = setup();
  expect(p.pal().scopes.map((s) => s.value)).toEqual(["all", "tab", "worktree", "file", "task", "other"]);
  const tab = p.key({ key: "Tab" });
  expect(tab.preventDefault).toHaveBeenCalled();
  expect(p.pal().scope).toBe("tab");
  expect(p.html()).toContain(en("palette.section.tabs"));
  expect(p.rows()).toHaveLength(1);
  p.key({ key: "Tab", shiftKey: true });
  p.key({ key: "Tab", shiftKey: true });
  expect(p.pal().scope).toBe("other");
  expect(p.html()).toContain(en("palette.section.other"));
  expect(p.rows()).toHaveLength(2);
});

it("picking a kind from the scope row filters and resets the active row", () => {
  const p = setup();
  p.nav("End");
  p.pal().onScopeChange("worktree");
  expect(p.pal().scope).toBe("worktree");
  expect(p.ids()).toEqual(["wt:/wt/oak", "wt:/wt/elm"]);
  expect(p.pal().activeId).toBe("wt:/wt/oak");
});

it("bare digit picks only on an empty query", () => {
  run.mockReset();
  const p = setup();
  p.type("o");
  p.key({ key: "1" });
  expect(run).not.toHaveBeenCalled();
  const q = setup();
  const e = q.key({ key: "3" });
  expect(e.preventDefault).toHaveBeenCalled();
  expect(run).toHaveBeenCalledWith("wt:/wt/oak");
});

it("ctrl+digit picks with a query", () => {
  run.mockReset();
  const p = setup();
  p.type("feat");
  p.key({ key: "1", ctrlKey: true });
  expect(run).toHaveBeenCalledWith("wt:/wt/oak");
});

const many = Array.from({ length: 30 }, (_, i) => mk(`wt:/wt/w${i}`, "worktree", `w${String(i).padStart(2, "0")}`, { worktree: `/wt/w${i}` }));

it("more row adds rows", () => {
  const p = setup({ items: many });
  p.type("w");
  expect(p.rows()).toHaveLength(9);
  expect(p.html()).toContain("22 more");
  p.nav("End");
  p.nav("Enter");
  expect(p.rows()).toHaveLength(29);
  expect(p.props.onClose).not.toHaveBeenCalled();
});

it("a click on the more row pages too", () => {
  const p = setup({ items: many });
  p.type("w");
  p.pal().onSelect(p.rows().at(-1)!);
  expect(p.rows()).toHaveLength(29);
});

it("create row calls onCreate with the query", () => {
  const p = setup({ canCreate: true });
  p.type("zzz");
  expect(p.html()).toContain("Create worktree &#x27;zzz&#x27;");
  p.nav("Enter");
  expect(p.props.onCreate).toHaveBeenCalledWith("zzz");
  expect(p.props.onClose).toHaveBeenCalled();
});

it("nothing matches shows the empty line", () => {
  const p = setup();
  p.type("qqqq");
  expect(p.rows()).toHaveLength(0);
  expect(p.pal().labels.noMatches).toBe(en("palette.empty"));
});

it("rows show their digit and the footer shows the hints", () => {
  const p = setup();
  const html = p.html();
  expect(html).toContain("<kbd");
  expect(JSON.stringify(p.rows()[0].meta)).toContain('"children":"1"');
  for (const k of ["move", "open", "close"]) expect(Object.values(p.pal().labels)).toContain(en(`palette.hint.${k}`));
  for (const k of ["filter", "pick"]) expect(html).toContain(en(`palette.hint.${k}`));
});

it("rows show the kind icon and the status dot", () => {
  const p = setup();
  expect(p.rows()[0].icon).toBe("terminal");
  expect(p.html()).toContain('class="pal-dot" data-status="needs-you"');
  expect(p.html()).toContain(`title="${en("palette.status.needs-you")}"`);
});

it("picking a row notes it as recent", () => {
  const recent = new RecentStore(null, () => 5);
  const p = setup({ recent });
  p.key({ key: "3" });
  expect(recent.at("wt:/wt/oak")).toBe(5);
});

it("keys during IME composition do nothing", () => {
  run.mockReset();
  const p = setup();
  const composing = { nativeEvent: { isComposing: true } };
  p.key({ key: "Enter", ...composing });
  p.key({ key: "Tab", ...composing });
  p.key({ key: "1", ...composing });
  p.key({ key: "Process", keyCode: 229 });
  p.key({ key: "Enter", keyCode: 229 });
  const tab = p.key({ key: "Tab", keyCode: 229 });
  expect(tab.preventDefault).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
  expect(p.props.onClose).not.toHaveBeenCalled();
  expect(p.pal().scope).toBe("all");
  // Selection did not move either: Enter after composition still runs the first row.
  p.nav("Enter");
  expect(run).toHaveBeenCalledWith("tab:p1");
});

it("ctrl+k inside the palette does not reach the window", () => {
  const p = setup();
  const e = p.key({ key: "k", ctrlKey: true });
  expect(e.stopPropagation).toHaveBeenCalled();
  expect(e.preventDefault).toHaveBeenCalled();
  const m = p.key({ key: "K", metaKey: true });
  expect(m.stopPropagation).toHaveBeenCalled();
});

it("the palette wrapper keeps the focus in the search box", () => {
  const p = setup();
  const press = (tag: string) => {
    const e = { target: { tagName: tag, closest: () => null }, preventDefault: vi.fn() };
    p.draw().props.onMouseDown(e);
    return e.preventDefault;
  };
  expect(press("BUTTON")).toHaveBeenCalled();
  expect(press("DIV")).toHaveBeenCalled();
  expect(press("INPUT")).not.toHaveBeenCalled();
});

const scoped = [
  mk("wt:/wt/oak", "worktree", "oak", { worktree: "/wt/oak", repo: "/r/x" }),
  mk("wt:/wt/pine", "worktree", "pine", { worktree: "/wt/pine", repo: "/r/y" }),
  mk("set:agents", "setting", "Agents"),
];
const scopes = [{ path: "/r/x", name: "xdev" }, { path: "/r/y", name: "other" }];
const chip = (p: ReturnType<typeof setup>) => p.parts().find((n) => String(n.props.className) === "pal-scope-chip");
const clear = (p: ReturnType<typeof setup>) => p.parts().find((n) => n.props.className === "pal-scope-clear")!;

it("the Filter button toggles the project menu", () => {
  const p = setup({ items: scoped, scopes });
  expect(p.filterBtn().props["aria-haspopup"]).toBe("menu");
  expect(p.filterBtn().props["aria-expanded"]).toBe(false);
  expect(p.hasMenu()).toBe(false);
  p.filterBtn().props.onClick();
  expect(p.filterBtn().props["aria-expanded"]).toBe(true);
  expect(p.menuItems().map((n) => n.props.children)).toEqual([en("palette.scope.all"), "xdev", "other"]);
  p.filterBtn().props.onClick();
  expect(p.hasMenu()).toBe(false);
});

it("picking a project narrows the rows and shows a chip that × clears", () => {
  const p = setup({ items: scoped, scopes });
  expect(p.rows()).toHaveLength(2);
  p.filterBtn().props.onClick();
  p.menuItems()[1].props.onClick();
  expect(p.rows()).toHaveLength(1);
  expect(p.html()).not.toContain("pine");
  expect(p.filterBtn().props["data-active"]).toBe(true);
  expect(JSON.stringify(chip(p)!.props.children)).toContain("xdev");
  clear(p).props.onClick();
  expect(p.rows()).toHaveLength(2);
  expect(p.filterBtn().props["data-active"]).toBe(false);
  expect(chip(p)).toBeUndefined();
});

it("the menu takes Up, Down and Enter", () => {
  const p = setup({ items: scoped, scopes });
  p.filterBtn().props.onClick();
  p.nav("ArrowDown");
  p.nav("ArrowDown");
  p.nav("Enter");
  expect(p.html()).toContain("other");
  expect(JSON.stringify(chip(p)!.props.children)).toContain("other");
  expect(p.props.onClose).not.toHaveBeenCalled();
});

it("Escape in the menu closes the menu and stops before the palette", () => {
  const p = setup({ items: scoped, scopes });
  p.filterBtn().props.onClick();
  const e = p.key({ key: "Escape" });
  expect(e.preventDefault).toHaveBeenCalled();
  expect(e.stopPropagation).toHaveBeenCalled();
  expect(p.hasMenu()).toBe(false);
  expect(p.props.onClose).not.toHaveBeenCalled();
  // With no menu the key is left to the palette, which closes.
  const bare = p.key({ key: "Escape" });
  expect(bare.stopPropagation).not.toHaveBeenCalled();
  expect(bare.defaultPrevented).toBe(false);
});

it("a press outside the menu closes it; a press inside does not", () => {
  const p = setup({ items: scoped, scopes });
  const at = (inside: boolean) => ({ target: { tagName: "DIV", closest: () => (inside ? {} : null) }, preventDefault: vi.fn() });
  p.filterBtn().props.onClick();
  p.draw().props.onMouseDown(at(true));
  expect(p.hasMenu()).toBe(true);
  p.draw().props.onMouseDown(at(false));
  expect(p.hasMenu()).toBe(false);
});

it("Tab and digits close the open menu without acting on the rows", () => {
  const p = setup({ items: scoped, scopes });
  run.mockClear();
  p.filterBtn().props.onClick();
  p.key({ key: "Tab" });
  expect(p.hasMenu()).toBe(false);
  expect(p.pal().scope).toBe("all");
  p.filterBtn().props.onClick();
  p.key({ key: "1" });
  expect(run).not.toHaveBeenCalled();
  expect(p.hasMenu()).toBe(false);
});

it("reopening resets the scope", () => {
  const p = setup({ items: scoped, scopes });
  p.filterBtn().props.onClick();
  p.menuItems()[1].props.onClick();
  expect(p.rows()).toHaveLength(1);
  p.draw();
  hooks.effects.splice(0).forEach((e) => e());
  expect(p.rows()).toHaveLength(2);
});

it("no projects, no Filter button", () => {
  const p = setup({ items: scoped });
  expect(p.addon()).toBeUndefined();
});

it("rows from queryItems join the ranked rows for the typed query", () => {
  const seen: string[] = [];
  const queryItems = (q: string) => (seen.push(q), q.length >= 2 ? [mk("file:src/oak.ts", "file", "oak.ts", { detail: "src", minQuery: 2 })] : []);
  const p = setup({ queryItems });
  p.type("oak");
  expect(p.html()).toContain(en("palette.section.files"));
  expect(seen).toContain("oak");
});
