import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RepoView, WorktreeView } from "@/api";
import { translate } from "@/i18n";
import { DEMO_WORKSPACE } from "@/mockWorkspace";
import { WorktreeList, type WorktreeListProps } from "./WorktreeList";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  // The profile store is outside what these tests render; its context keeps the default.
  useContext: (ctx: { _currentValue: unknown }) => ctx._currentValue,
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value; }];
  },
}));
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

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
  id: "repo-2-notes", shortName: "notes", path: "/code/notes", baseRef: "main", worktreeRoot: "/code/wt", missing: false,
  worktrees: [{ path: "/code/notes", name: "notes", branch: null, head: null, start: null, primary: true, pinned: false, detached: true }],
  found: [],
};
// A repo whose folder is gone comes back with no worktrees.
const gone: RepoView = { id: "repo-3-gone", shortName: "gone", path: "/code/gone", baseRef: "main", worktreeRoot: "/code/wt", missing: true, worktrees: [], found: [] };
const repos = (): RepoView[] => {
  const [xdev] = structuredClone(DEMO_WORKSPACE.repos);
  xdev.worktrees[2].pinned = true;
  return [xdev, notes, gone];
};

const DOTS: Record<string, "working" | "failed" | "idle"> = { "/demo/wt/xdev-oak": "working", "/demo/wt/xdev-elm": "failed" };

function harness(dots: Record<string, "working" | "failed" | "idle"> = DOTS, list: () => RepoView[] = repos, extra: Partial<WorktreeListProps> = {}) {
  const calls = { select: [] as WorktreeView[], create: 0, pin: [] as WorktreeView[], remove: [] as WorktreeView[], add: 0 };
  const draw = () => {
    hooks.cursor = 0;
    return WorktreeList({
      repos: list(),
      selected: "/demo/wt/xdev-oak",
      dots,
      ...extra,
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
  const menu = () => all().find(n => n.props.role === "menu");
  return { calls, all, html, row, main, more, item, menu };
}

// A stand-in for the open menu's DOM: its items and the row's more button record focus.
function dom(labels: string[]) {
  const focused: string[] = [];
  const el = (name: string) => ({ name, focus: () => void focused.push(name) });
  const items = labels.map(el);
  const more = el("more");
  const menu = { querySelectorAll: () => items, parentElement: { querySelector: () => more } };
  let prevented = 0;
  const key = (key: string, on = 0) => ({ key, target: items[on], currentTarget: menu, preventDefault: () => void prevented++ });
  return { focused, key, prevented: () => prevented };
}

beforeEach(() => { hooks.values = []; hooks.cursor = 0; });

it("lists worktrees by status group, keeps repo order inside one, and no delete on the primary", () => {
  const view = harness();
  const html = view.html();
  // failed (needs you), working, then the rest: the primary checkouts of xdev and notes.
  const order = ["/demo/wt/xdev-elm", "/demo/wt/xdev-oak", "/demo/xdev", "/code/notes"].map(s => html.indexOf(s));
  expect(order.every(i => i >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(html).toContain(en("workspace.primary"));
  expect(html).toContain(en("workspace.missing"));
  expect(html).toContain(en("workspace.detached"));
  expect(html).toContain('data-dot="working"');
  expect(html).toContain('data-dot="failed"');
  expect(html).toContain(`aria-label="${en("workspace.pinned")}"`);
  expect(view.main("/demo/wt/xdev-oak").props["aria-current"]).toBe("true");

  // The primary checkout can be pinned but never removed.
  expect(view.more("/demo/xdev")).toBeDefined();
  view.main("/demo/xdev").props.onContextMenu(event);
  expect(view.item(en("workspace.delete"))).toBeUndefined();
  view.item(en("workspace.pin"))!.props.onClick();
  expect(view.calls.pin.map(w => w.path)).toEqual(["/demo/xdev"]);
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
  expect(view.calls.pin.map(w => w.path)).toEqual(["/demo/xdev", "/demo/wt/xdev-elm"]);
});

it("new worktree and add repo call back", () => {
  const view = harness();
  view.all().find(n => n.props["aria-label"] === en("workspace.new"))!.props.onClick();
  view.all().find(n => n.props.className === "ws-add-repo")!.props.onClick();
  expect(view.calls.create).toBe(1);
  expect(view.calls.add).toBe(1);
});

it("arrow keys move between menu items", () => {
  const view = harness();
  view.more("/demo/wt/xdev-oak")!.props.onClick();
  const two = dom(["pin", "delete"]);
  view.menu()!.props.onKeyDown(two.key("ArrowDown", 0));
  view.menu()!.props.onKeyDown(two.key("ArrowDown", 1));
  view.menu()!.props.onKeyDown(two.key("ArrowUp", 0));
  view.menu()!.props.onKeyDown(two.key("Home", 1));
  view.menu()!.props.onKeyDown(two.key("End", 0));
  expect(two.focused).toEqual(["delete", "pin", "delete", "pin", "delete"]);
  expect(two.prevented()).toBe(5);
  expect(view.menu()).toBeDefined();

  // The primary row has one item; the keys keep focus on it.
  view.more("/demo/wt/xdev-oak")!.props.onClick();
  view.more("/demo/xdev")!.props.onClick();
  const one = dom(["pin"]);
  for (const k of ["ArrowDown", "ArrowUp", "Home", "End"]) view.menu()!.props.onKeyDown(one.key(k));
  expect(one.focused).toEqual(["pin", "pin", "pin", "pin"]);
});

it("Escape returns focus to the more button", () => {
  const view = harness();
  view.more("/demo/wt/xdev-oak")!.props.onClick();
  const page = dom(["pin", "delete"]);
  view.menu()!.props.onKeyDown(page.key("Escape", 1));
  expect(page.focused).toEqual(["more"]);
  expect(view.menu()).toBeUndefined();
});

it("Tab closes the menu", () => {
  const view = harness();
  view.main("/demo/wt/xdev-oak").props.onContextMenu(event);
  const page = dom(["pin", "delete"]);
  view.menu()!.props.onKeyDown(page.key("Tab"));
  expect(view.menu()).toBeUndefined();
  // Focus is not trapped: the browser's own Tab move goes ahead.
  expect(page.prevented()).toBe(0);

  view.main("/demo/wt/xdev-oak").props.onContextMenu(event);
  view.all().find(n => n.props.className === "ws-menu-backdrop")!.props.onClick();
  expect(view.menu()).toBeUndefined();
});

const names = (view: ReturnType<typeof harness>) =>
  view.all().filter(n => n.props.className === "ws-group-head").map(h => nodes(h.props.children).map(c => (typeof c.props.children === "string" || typeof c.props.children === "number" ? String(c.props.children) : "")).join(" ").trim());
const head = (view: ReturnType<typeof harness>, group: string) => view.all().find(n => n.props.className === "ws-group-head" && n.props["data-group"] === group)!;

const two = (): RepoView[] => {
  const [xdev] = structuredClone(DEMO_WORKSPACE.repos);
  return [xdev];
};

it("shows group headers with counts", () => {
  // Two working, one idle, the primary checkout without a status.
  const view = harness({ "/demo/wt/xdev-oak": "working", "/demo/wt/xdev-elm": "working", "/demo/xdev": "idle" }, two);
  expect(names(view)).toEqual([`${en("workspace.group.working")} 2`, `${en("workspace.group.review")} 1`]);
  expect(translate("vi", "workspace.group.working")).toBe("Đang chạy");
  expect(translate("vi", "workspace.group.review")).toBe("Chờ duyệt");
  expect(head(view, "working").props["aria-expanded"]).toBe(true);
});

it("collapses a group on header click", () => {
  const view = harness();
  expect(view.html()).toContain("/demo/wt/xdev-oak");
  head(view, "working").props.onClick();
  expect(head(view, "working").props["aria-expanded"]).toBe(false);
  // Its rows leave; the other groups keep theirs. The state lives on across draws.
  expect(view.html()).not.toContain("/demo/wt/xdev-oak");
  expect(view.html()).toContain("/demo/wt/xdev-elm");
  expect(head(view, "working").props["aria-expanded"]).toBe(false);
  head(view, "working").props.onClick();
  expect(view.html()).toContain("/demo/wt/xdev-oak");
});

const NOW = 1_000_000_000;
const text = (node: Node): string => [node.props.children].flat().filter(c => typeof c === "string").join("");
const withData = (extra: Partial<WorktreeListProps> = {}) => harness(DOTS, repos, {
  now: NOW,
  stats: { "/demo/wt/xdev-oak": { files: 3, added: 5, removed: 1 }, "/demo/wt/xdev-elm": { files: 0, added: 0, removed: 0 } },
  activity: { "/demo/wt/xdev-oak": NOW - 5 * 60_000 },
  profiles: { "/demo/wt/xdev-oak": ["claude", "shell", "codex"], "/demo/wt/xdev-elm": ["shell"] },
  ...extra,
});
const part = (view: ReturnType<typeof harness>, path: string, cls: string) => nodes(view.row(path).props.children).filter(n => n.props.className === cls);

it("row shows time, branch, agent chips and line counts", () => {
  const view = withData();
  const oak = "/demo/wt/xdev-oak";
  expect(part(view, oak, "ws-wt-time").map(text)).toEqual(["5 min"]);
  expect(part(view, oak, "ws-wt-branch").map(text)).toEqual(["oak"]);
  // Chips for the agents in tab order; the shell has none.
  expect(part(view, oak, "ws-chip").map(text)).toEqual(["C", "X"]);
  expect(part(view, oak, "ws-chip").map(n => n.props["data-profile"])).toEqual(["claude", "codex"]);
  expect(part(view, oak, "ws-chip").map(n => n.props.title)).toEqual([en("terminal.profile.claude"), en("terminal.profile.codex")]);
  const counts = part(view, oak, "ws-stat")[0];
  expect(nodes(counts.props.children).filter(n => typeof n.props.children === "string").map(n => n.props.children).join(" ")).toBe("+5 −1");
  expect(counts.props.title).toBe(en("workspace.row.stat", { files: 3, added: 5, removed: 1 }));
  expect(view.html()).toContain("+5</span> <span");

  // Nothing read, nothing run, no chip and no counts: the row keeps just its name and branch.
  for (const path of ["/demo/wt/xdev-elm", "/demo/xdev", "/code/notes"]) {
    expect(part(view, path, "ws-wt-time")).toHaveLength(0);
    expect(part(view, path, "ws-chip")).toHaveLength(0);
    expect(part(view, path, "ws-stat")).toHaveLength(0);
    expect(part(view, path, "ws-wt-meta")).toHaveLength(0);
  }
});

it("a repo whose folder is gone stays listed with its name, a missing tag and its path", () => {
  const html = harness().html();
  expect(html).toMatch(/<li class="ws-missing" title="\/code\/gone">/);
  const item = html.slice(html.indexOf('class="ws-missing"'));
  expect(item).toContain(">gone<");
  expect(item).toContain(`title="${en("workspace.missingTitle")}"`);
  expect(item).toContain(en("workspace.missing"));
  // Only gone repos: still listed, and no worktree can be made.
  const only = harness(DOTS, () => [gone]).html();
  expect(only).toContain('class="ws-missing"');
  expect(only).toMatch(new RegExp(`aria-label="${en("workspace.new")}"[^>]*disabled=""`));
  // A present repo has no such row.
  expect(harness(DOTS, () => [notes]).html()).not.toContain("ws-missing");
});

it("a long name and branch are cut by the row and keep their full text in a title", () => {
  const long = "feature/a-very-long-branch-name-that-does-not-fit-in-the-sidebar-at-all";
  const view = withData({ repos: structuredClone(repos()).map(r => ({ ...r, worktrees: r.worktrees.map(w => w.name === "oak" ? { ...w, name: long, branch: long } : w) })) });
  const oak = "/demo/wt/xdev-oak";
  expect(nodes(view.row(oak).props.children).find(n => n.props.className === "ws-wt-name")!.props.title).toBe(long);
  expect(part(view, oak, "ws-wt-branch")[0].props.title).toBe(long);
  // The counts stay in their own non-shrinking element, after the cut text.
  expect(part(view, oak, "ws-stat")).toHaveLength(1);
});

const FOUND: WorktreeView = { path: "/demo/elsewhere/spike", name: "spike", branch: "spike", head: "6666666666666666666666666666666666666666", start: null, primary: false, pinned: false, detached: false };

it("found worktrees show under their repo and Adopt calls onAdopt", () => {
  const adopted: WorktreeView[] = [];
  const withFound = () => {
    const list = repos();
    list[0].found = [FOUND];
    return list;
  };
  const view = harness(DOTS, withFound, { onAdopt: (w) => adopted.push(w) });
  const group = () => view.all().find(n => n.props.className === "ws-found" && n.props["data-repo"] === "demo-xdev")!;
  const toggle = () => nodes(group().props.children).find(n => n.type === "button" && n.props.className?.includes("ws-found-head"))!;
  expect(view.all().filter(n => n.props.className === "ws-found")).toHaveLength(1);
  expect(text(nodes(toggle().props.children).find(n => n.props.className === "ws-group-name")!)).toBe(en("workspace.found.title", { count: 1 }));
  // Collapsed at first: the found rows are not in the list of worktrees.
  expect(toggle().props["aria-expanded"]).toBe(false);
  expect(view.html()).not.toContain("/demo/elsewhere/spike");
  toggle().props.onClick();
  expect(toggle().props["aria-expanded"]).toBe(true);
  expect(view.html()).toContain("/demo/elsewhere/spike");
  // A found worktree is not selectable as a row of the list.
  expect(view.all().some(n => n.props.className === "ws-wt" && n.props["data-path"] === FOUND.path)).toBe(false);
  const adopt = nodes(group().props.children).find(n => n.type === "button" && n.props.children === en("workspace.found.adopt"))!;
  expect(adopt.props["aria-label"]).toBe(en("workspace.found.adoptLabel", { name: "spike" }));
  adopt.props.onClick();
  expect(adopted).toEqual([FOUND]);
});

it("no found group when found is empty", () => {
  const view = harness(DOTS, repos, { onAdopt: () => {} });
  expect(view.all().some(n => n.props.className === "ws-found")).toBe(false);
  expect(view.html()).not.toContain(en("workspace.found.title", { count: 0 }));
});

const PR12 = { number: 12, url: "https://example.test/pull/12", state: "open" as const, title: "t", base: "main", head: "oak" };
const OAK_PATH = "/demo/wt/xdev-oak";

it("shows the PR chip with state and checks", () => {
  const checks = [{ name: "build", workflow: "ci", bucket: "fail" as const, link: null }, { name: "lint", workflow: "ci", bucket: "pass" as const, link: null }];
  const html = harness(DOTS, repos, { prs: { [OAK_PATH]: { pr: PR12, checks } } }).html();
  expect(html).toContain('aria-label="Pull request #12, open, checks failing"');
  expect(html).toContain('data-pr="open"');
  expect(html).toContain('data-check="fail"');
  expect(html).toContain("#12");
  // Checks not known yet: the chip has the state dot only.
  const bare = harness(DOTS, repos, { prs: { [OAK_PATH]: { pr: { ...PR12, state: "draft" }, checks: null } } }).html();
  expect(bare).toContain('aria-label="Pull request #12, draft"');
  expect(bare).not.toContain("data-check=");
  const none = harness(DOTS, repos, { prs: { [OAK_PATH]: { pr: PR12, checks: [] } } }).html();
  expect(none).not.toContain("data-check=");
});

it("no chip without a PR", () => {
  expect(harness().html()).not.toContain("ws-pr");
  expect(harness(DOTS, repos, { prs: { [OAK_PATH]: { pr: null, checks: null } } }).html()).not.toContain("ws-pr");
});
