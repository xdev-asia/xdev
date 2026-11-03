import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RepoView, WorktreeView } from "../api";
import { translate } from "../i18n";
import { DEMO_WORKSPACE } from "../mockWorkspace";
import { WorktreeList } from "./WorktreeList";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value; }];
  },
}));
vi.mock("../i18n", async (original) => ({ ...await original<typeof import("../i18n")>(), useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const event = { preventDefault() {} };

const notes: RepoView = {
  id: "repo-2-notes", shortName: "notes", path: "/code/notes", baseRef: "main", missing: true,
  worktrees: [{ path: "/code/notes", name: "notes", branch: null, head: null, start: null, primary: true, pinned: false, detached: true }],
};
const repos = (): RepoView[] => {
  const [xdev] = structuredClone(DEMO_WORKSPACE.repos);
  xdev.worktrees[2].pinned = true;
  return [xdev, notes];
};

function harness() {
  const calls = { select: [] as WorktreeView[], create: 0, pin: [] as WorktreeView[], remove: [] as WorktreeView[], add: 0 };
  const draw = () => {
    hooks.cursor = 0;
    return WorktreeList({
      repos: repos(),
      selected: "/demo/wt/xdev-oak",
      dots: { "/demo/wt/xdev-oak": "working", "/demo/wt/xdev-elm": "failed" },
      onSelect: (w) => calls.select.push(w),
      onCreate: () => void calls.create++,
      onPin: (w) => calls.pin.push(w),
      onRemove: (w) => calls.remove.push(w),
      onAddRepo: () => void calls.add++,
    });
  };
  const all = () => nodes(draw());
  const html = () => renderToStaticMarkup(draw());
  const row = (path: string) => all().find(n => n.props.className === "ws-wt" && n.props["data-path"] === path)!;
  const inRow = (path: string) => nodes(row(path).props.children);
  const main = (path: string) => inRow(path).find(n => n.props.className === "ws-wt-main")!;
  const more = (path: string) => inRow(path).find(n => n.props.className === "ws-wt-more");
  const item = (label: string) => all().find(n => n.props.role === "menuitem" && n.props.children === label);
  return { calls, all, html, row, main, more, item };
}

beforeEach(() => { hooks.values = []; hooks.cursor = 0; });

it("lists worktrees grouped by repo with the primary first and no delete on it", () => {
  const view = harness();
  const html = view.html();
  const order = [">xdev<", "/demo/xdev", "/demo/wt/xdev-oak", "/demo/wt/xdev-elm", ">notes<"].map(s => html.indexOf(s));
  expect(order.every(i => i >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(html).toContain(en("workspace.primary"));
  expect(html).toContain(en("workspace.missing"));
  expect(html).toContain(en("workspace.detached"));
  expect(html).toContain('data-dot="working"');
  expect(html).toContain('data-dot="failed"');
  expect(html).toContain(`aria-label="${en("workspace.pinned")}"`);
  expect(view.main("/demo/wt/xdev-oak").props["aria-current"]).toBe("true");

  // The primary checkout has no menu at all: it can be neither pinned nor removed here.
  expect(view.more("/demo/xdev")).toBeUndefined();
  view.main("/demo/xdev").props.onContextMenu(event);
  expect(view.all().some(n => n.props.role === "menu")).toBe(false);

  view.main("/demo/wt/xdev-oak").props.onClick();
  expect(view.calls.select.map(w => w.path)).toEqual(["/demo/wt/xdev-oak"]);

  view.main("/demo/wt/xdev-oak").props.onContextMenu(event);
  expect(view.item(en("workspace.pin"))).toBeDefined();
  view.item(en("workspace.delete"))!.props.onClick();
  expect(view.calls.remove.map(w => w.path)).toEqual(["/demo/wt/xdev-oak"]);
  expect(view.all().some(n => n.props.role === "menu")).toBe(false);

  view.more("/demo/wt/xdev-elm")!.props.onClick();
  view.item(en("workspace.unpin"))!.props.onClick();
  expect(view.calls.pin.map(w => w.path)).toEqual(["/demo/wt/xdev-elm"]);
});

it("new worktree and add repo call back", () => {
  const view = harness();
  view.all().find(n => n.props["aria-label"] === en("workspace.new"))!.props.onClick();
  view.all().find(n => n.props.className === "ws-add-repo")!.props.onClick();
  expect(view.calls.create).toBe(1);
  expect(view.calls.add).toBe(1);
});

it("a repo group collapses", () => {
  const view = harness();
  const head = () => view.all().find(n => n.props.className === "ws-group-head" && n.props["data-repo"] === "demo-xdev")!;
  expect(head().props["aria-expanded"]).toBe(true);
  head().props.onClick();
  expect(head().props["aria-expanded"]).toBe(false);
  expect(view.html()).not.toContain("/demo/wt/xdev-oak");
});
