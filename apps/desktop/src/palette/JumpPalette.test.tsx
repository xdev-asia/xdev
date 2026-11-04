import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
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

function setup(over: Partial<JumpPaletteProps> = {}) {
  const props: JumpPaletteProps = { open: true, items, current: { worktree: null, tab: null }, recent: new RecentStore(null, () => 1), canCreate: false, onCreate: vi.fn(), onClose: vi.fn(), now: 10, ...over };
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return JumpPalette(props) as Node; } finally { hooks.active = false; }
  };
  draw();
  hooks.effects.splice(0).forEach((e) => e());
  const key = (init: Record<string, unknown>) => {
    const e = { key: "", ctrlKey: false, metaKey: false, shiftKey: false, keyCode: 0, nativeEvent: { isComposing: false }, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...init };
    draw().props.onKeyDown(e);
    return e;
  };
  const type = (value: string) => nodes(draw()).find((n) => n.type === "input")!.props.onChange({ target: { value } });
  const html = () => renderToStaticMarkup(draw());
  const rows = () => nodes(draw()).filter((n) => n.props.role === "option");
  return { props, draw, key, type, html, rows };
}

it("titled Jump to and lists recent rows on open", () => {
  const p = setup();
  const html = p.html();
  expect(html).toContain("Jump to…");
  expect(html).toContain(en("palette.section.recentTabs"));
  expect(html).toContain(en("palette.section.recentWorktrees"));
  expect(p.rows()).toHaveLength(3);
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
  p.key({ key: "ArrowUp" });
  p.key({ key: "Enter" });
  expect(run).toHaveBeenCalledWith("wt:/wt/oak");
  expect(p.props.onClose).toHaveBeenCalled();
  p.key({ key: "ArrowDown" });
  p.key({ key: "Enter" });
  expect(run).toHaveBeenLastCalledWith("tab:p1");
});

it("escape closes", () => {
  const p = setup();
  const e = { preventDefault: vi.fn() };
  p.draw().props.onCancel(e);
  expect(e.preventDefault).toHaveBeenCalled();
  expect(p.props.onClose).toHaveBeenCalled();
});

it("tab and shift+tab cycle the filter and keep focus", () => {
  const p = setup();
  const tab = p.key({ key: "Tab" });
  expect(tab.preventDefault).toHaveBeenCalled();
  expect(p.html()).toContain(en("palette.section.tabs"));
  expect(p.rows()).toHaveLength(1);
  p.key({ key: "Tab", shiftKey: true });
  p.key({ key: "Tab", shiftKey: true });
  expect(p.html()).toContain(en("palette.section.other"));
  expect(p.rows()).toHaveLength(2);
});

it("bare digit picks only on an empty query", () => {
  run.mockReset();
  const p = setup();
  p.type("o");
  p.key({ key: "1" });
  expect(run).not.toHaveBeenCalled();
  const q = setup();
  q.key({ key: "3" });
  expect(run).toHaveBeenCalledWith("wt:/wt/oak");
});

it("ctrl+digit picks with a query", () => {
  run.mockReset();
  const p = setup();
  p.type("feat");
  p.key({ key: "1", ctrlKey: true });
  expect(run).toHaveBeenCalledWith("wt:/wt/oak");
});

it("more row adds rows", () => {
  const many = Array.from({ length: 30 }, (_, i) => mk(`wt:/wt/w${i}`, "worktree", `w${String(i).padStart(2, "0")}`, { worktree: `/wt/w${i}` }));
  const p = setup({ items: many });
  p.type("w");
  expect(p.rows()).toHaveLength(9);
  expect(p.html()).toContain("22 more");
  p.key({ key: "End" });
  p.key({ key: "Enter" });
  expect(p.rows()).toHaveLength(29);
  expect(p.props.onClose).not.toHaveBeenCalled();
});

it("create row calls onCreate with the query", () => {
  const p = setup({ canCreate: true });
  p.type("zzz");
  expect(p.html()).toContain("Create worktree &#x27;zzz&#x27;");
  p.key({ key: "Enter" });
  expect(p.props.onCreate).toHaveBeenCalledWith("zzz");
  expect(p.props.onClose).toHaveBeenCalled();
});

it("nothing matches shows the empty line", () => {
  const p = setup();
  p.type("qqqq");
  expect(p.html()).toContain(en("palette.empty"));
});

it("rows show their digit and the footer shows the hints", () => {
  const html = setup().html();
  expect(html).toContain('<kbd class="pal-key">1</kbd>');
  for (const k of ["move", "open", "filter", "pick", "close"]) expect(html).toContain(en(`palette.hint.${k}`));
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
  p.key({ key: "ArrowDown", ...composing });
  p.key({ key: "1", ...composing });
  p.key({ key: "Process", keyCode: 229 });
  p.key({ key: "Enter", keyCode: 229 });
  expect(run).not.toHaveBeenCalled();
  expect(p.props.onClose).not.toHaveBeenCalled();
  // Selection did not move either: Enter after composition still runs the first row.
  p.key({ key: "Enter" });
  expect(run).toHaveBeenCalledWith("tab:p1");
});

it("the selected row scrolls into view", () => {
  const p = setup();
  const scroll = (index: number) => {
    const el = { scrollIntoView: vi.fn() };
    p.rows()[index].props.ref?.(el);
    return el.scrollIntoView;
  };
  expect(scroll(0)).toHaveBeenCalledWith({ block: "nearest" });
  expect(scroll(1)).not.toHaveBeenCalled();
  p.key({ key: "End" });
  expect(scroll(2)).toHaveBeenCalledWith({ block: "nearest" });
  expect(scroll(0)).not.toHaveBeenCalled();
});

it("ctrl+k inside the palette does not reach the window", () => {
  const p = setup();
  const e = p.key({ key: "k", ctrlKey: true });
  expect(e.stopPropagation).toHaveBeenCalled();
  expect(e.preventDefault).toHaveBeenCalled();
  const m = p.key({ key: "K", metaKey: true });
  expect(m.stopPropagation).toHaveBeenCalled();
});

const scoped = [
  mk("wt:/wt/oak", "worktree", "oak", { worktree: "/wt/oak", repo: "/r/x" }),
  mk("wt:/wt/pine", "worktree", "pine", { worktree: "/wt/pine", repo: "/r/y" }),
  mk("set:agents", "setting", "Agents"),
];
const scopes = [{ path: "/r/x", name: "xdev" }, { path: "/r/y", name: "other" }];
const find = (p: ReturnType<typeof setup>, pred: (n: Node) => boolean) => nodes(p.draw()).find(pred)!;
const filterBtn = (p: ReturnType<typeof setup>) => find(p, (n) => n.props.className === "pal-filter-btn");
const menuItems = (p: ReturnType<typeof setup>) => nodes(p.draw()).filter((n) => n.props.role === "menuitemradio");

it("the Filter button toggles the project menu", () => {
  const p = setup({ items: scoped, scopes });
  expect(filterBtn(p).props["aria-haspopup"]).toBe("menu");
  expect(filterBtn(p).props["aria-expanded"]).toBe(false);
  expect(nodes(p.draw()).some((n) => n.props.role === "menu")).toBe(false);
  filterBtn(p).props.onClick();
  expect(filterBtn(p).props["aria-expanded"]).toBe(true);
  expect(menuItems(p).map((n) => n.props.children)).toEqual([en("palette.scope.all"), "xdev", "other"]);
  filterBtn(p).props.onClick();
  expect(nodes(p.draw()).some((n) => n.props.role === "menu")).toBe(false);
});

it("picking a project narrows the rows and shows a chip that × clears", () => {
  const p = setup({ items: scoped, scopes });
  expect(p.rows()).toHaveLength(2);
  filterBtn(p).props.onClick();
  menuItems(p)[1].props.onClick();
  expect(p.rows()).toHaveLength(1);
  expect(p.html()).not.toContain("pine");
  expect(filterBtn(p).props["data-active"]).toBe(true);
  const chip = find(p, (n) => String(n.props.className).includes("pal-scope-chip"));
  expect(JSON.stringify(chip.props.children)).toContain("xdev");
  find(p, (n) => n.props.className === "pal-scope-clear").props.onClick();
  expect(p.rows()).toHaveLength(2);
  expect(filterBtn(p).props["data-active"]).toBe(false);
});

it("the menu takes Up, Down and Enter", () => {
  const p = setup({ items: scoped, scopes });
  filterBtn(p).props.onClick();
  p.key({ key: "ArrowDown" });
  p.key({ key: "ArrowDown" });
  p.key({ key: "Enter" });
  expect(p.html()).toContain("other");
  expect(find(p, (n) => String(n.props.className).includes("pal-scope-chip")).props.children[0]).toBe("other");
  expect(p.props.onClose).not.toHaveBeenCalled();
});

it("Escape in the menu closes the menu, not the palette", () => {
  const p = setup({ items: scoped, scopes });
  filterBtn(p).props.onClick();
  const e = p.key({ key: "Escape" });
  expect(e.preventDefault).toHaveBeenCalled();
  expect(nodes(p.draw()).some((n) => n.props.role === "menu")).toBe(false);
  const cancel = { preventDefault: vi.fn() };
  filterBtn(p).props.onClick();
  p.draw().props.onCancel(cancel);
  expect(p.props.onClose).not.toHaveBeenCalled();
  p.draw().props.onCancel(cancel);
  expect(p.props.onClose).toHaveBeenCalledTimes(1);
});

it("Tab still cycles five chips", () => {
  const p = setup({ items: scoped, scopes });
  expect(nodes(p.draw()).filter((n) => n.props.role === "tab")).toHaveLength(5);
  for (let i = 0; i < 5; i++) p.key({ key: "Tab" });
  const active = nodes(p.draw()).filter((n) => n.props.role === "tab" && n.props["aria-selected"]);
  expect(active[0].props.children).toBe(en("palette.filter.all"));
});

it("reopening resets the scope", () => {
  const p = setup({ items: scoped, scopes });
  filterBtn(p).props.onClick();
  menuItems(p)[1].props.onClick();
  expect(p.rows()).toHaveLength(1);
  p.draw();
  hooks.effects.splice(0).forEach((e) => e());
  expect(p.rows()).toHaveLength(2);
});

it("no projects, no Filter button", () => {
  const p = setup({ items: scoped });
  expect(nodes(p.draw()).some((n) => n.props.className === "pal-filter-btn")).toBe(false);
});
