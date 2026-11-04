import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RepoView, WorktreeView } from "@/api";
import { translate } from "@/i18n";
import { DEMO_WORKSPACE } from "@/mockWorkspace";
import { ContextMenu, type MenuItem } from "@/ui/ContextMenu";
import { WorktreeList, type WorktreeListProps } from "./WorktreeList";
import { NO_DETAILS } from "@/workspace/worktreeDetails";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  // The profile store is outside what these tests render; its context keeps the default.
  useContext: (ctx: { _currentValue: unknown }) => ctx._currentValue,
  // Effects do not run when the list is called as a function; the order it reports is checked below.
  useEffect: (effect: () => void) => void hooks.effects.push(effect),
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
  id: "repo-2-notes", shortName: "notes", path: "/code/notes", baseRef: "main", worktreeRoot: "/code/wt", setupPolicy: "ask", scriptSource: "auto", localSetup: "", localArchive: "", missing: false,
  worktrees: [{ path: "/code/notes", name: "notes", branch: null, head: null, start: null, primary: true, pinned: false, detached: true, ...NO_DETAILS }],
  found: [],
};
// A repo whose folder is gone comes back with no worktrees.
const gone: RepoView = { id: "repo-3-gone", shortName: "gone", path: "/code/gone", baseRef: "main", worktreeRoot: "/code/wt", setupPolicy: "ask", scriptSource: "auto", localSetup: "", localArchive: "", missing: true, worktrees: [], found: [] };
const repos = (): RepoView[] => {
  const [xdev] = structuredClone(DEMO_WORKSPACE.repos);
  xdev.worktrees[2].pinned = true;
  return [xdev, notes, gone];
};

const DOTS: Record<string, "working" | "failed" | "idle" | "done"> = { "/demo/wt/xdev-oak": "working", "/demo/wt/xdev-elm": "failed" };

function harness(dots: Record<string, "working" | "failed" | "idle" | "done"> = DOTS, list: () => RepoView[] = repos, extra: Partial<WorktreeListProps> = {}) {
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
  const row = (path: string) => all().find(n => /^ws-wt( |$)/.test(n.props.className ?? "") && n.props["data-path"] === path)!;
  const inRow = (path: string) => nodes(row(path).props.children);
  const main = (path: string) => inRow(path).find(n => n.props.className === "ws-wt-main")!;
  const more = (path: string) => inRow(path).find(n => n.props.className === "ws-wt-more");
  const menu = () => all().find(n => n.type === ContextMenu);
  const flat = (items: MenuItem[]): MenuItem[] => items.flatMap(i => [i, ...flat(i.children ?? [])]);
  const item = (id: string) => flat((menu()?.props.items ?? []) as MenuItem[]).find(i => i.id === id);
  return { calls, all, html, row, inRow, main, more, item, menu };
}

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; });

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
  expect(html).toContain('class="ws-glyph" data-status="working"');
  expect(html).toContain('class="ws-glyph" data-status="failed"');
  expect(html).toContain(`aria-label="${en("workspace.status.failed")}"`);
  expect(html).toContain(`aria-label="${en("workspace.pinned")}"`);
  expect(view.main("/demo/wt/xdev-oak").props["aria-current"]).toBe("true");

  // The primary checkout can be pinned but never removed.
  expect(view.more("/demo/xdev")).toBeDefined();
  view.main("/demo/xdev").props.onContextMenu(event);
  expect(view.item("delete")).toBeUndefined();
  view.item("pin")!.run!();
  expect(view.calls.pin.map(w => w.path)).toEqual(["/demo/xdev"]);
  expect(view.menu()).toBeDefined();

  view.main("/demo/wt/xdev-oak").props.onClick();
  expect(view.calls.select.map(w => w.path)).toEqual(["/demo/wt/xdev-oak"]);

  view.main("/demo/wt/xdev-oak").props.onContextMenu(event);
  expect(view.item("pin")).toBeDefined();
  view.item("delete")!.run!();
  expect(view.calls.remove.map(w => w.path)).toEqual(["/demo/wt/xdev-oak"]);
  expect(view.menu()).toBeDefined();

  view.more("/demo/wt/xdev-elm")!.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 0, bottom: 0 }) } });
  view.item("pin")!.run!();
  expect(view.calls.pin.map(w => w.path)).toEqual(["/demo/xdev", "/demo/wt/xdev-elm"]);
});

it("an unread worktree is bold, says so, and the menu can mark one unread", () => {
  const marked: string[] = [];
  const view = harness({ ...DOTS, "/demo/xdev": "done" }, repos, {
    unread: { "/demo/xdev": true },
    onMarkUnread: (w) => void marked.push(w.path),
  });
  expect(view.row("/demo/xdev").props.className).toBe("ws-wt ws-wt-unread");
  expect(view.row("/demo/wt/xdev-oak").props.className).toBe("ws-wt");
  const glyph = view.inRow("/demo/xdev").find(n => n.props.className === "ws-glyph")!;
  expect(glyph.props["data-status"]).toBe("done");
  expect(glyph.props["aria-label"]).toBe(`${en("workspace.status.done")}, unread`);
  expect(translate("vi", "workspace.unreadStatus", { status: "x" })).toBe("x, chưa xem");

  // Right-click and the more button open the same menu, both with Mark unread.
  view.main("/demo/wt/xdev-oak").props.onContextMenu(event);
  view.item("markUnread")!.run!();
  view.more("/demo/wt/xdev-elm")!.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 0, bottom: 0 }) } });
  view.item("markUnread")!.run!();
  expect(marked).toEqual(["/demo/wt/xdev-oak", "/demo/wt/xdev-elm"]);

  // Without the callback the item is not offered.
  const plain = harness();
  plain.main("/demo/wt/xdev-oak").props.onContextMenu(event);
  expect(plain.item("markUnread")).toBeUndefined();
});

it("an unread row offers Mark read in place of Mark unread", () => {
  const read: string[] = [];
  const view = harness({ ...DOTS, "/demo/xdev": "done" }, repos, {
    unread: { "/demo/xdev": true },
    onMarkUnread: () => undefined,
    onMarkRead: (w) => void read.push(w.path),
  });
  view.main("/demo/xdev").props.onContextMenu(event);
  expect(view.item("markUnread")).toBeUndefined();
  view.item("markRead")!.run!();
  expect(read).toEqual(["/demo/xdev"]);
  // A row that is read still offers Mark unread.
  view.main("/demo/wt/xdev-oak").props.onContextMenu(event);
  expect(view.item("markUnread")).toBeDefined();
});

it("new worktree and add repo call back", () => {
  const view = harness();
  view.all().find(n => n.props["aria-label"] === en("workspace.new"))!.props.onClick();
  view.all().find(n => n.props.className === "ws-add-repo")!.props.onClick();
  expect(view.calls.create).toBe(1);
  expect(view.calls.add).toBe(1);
});

it("the more button and a right-click open the menu at a point and it closes by onClose", () => {
  const view = harness();
  view.main("/demo/wt/xdev-oak").props.onContextMenu({ ...event, clientX: 30, clientY: 40 });
  expect(view.menu()!.props.at).toEqual({ x: 30, y: 40 });
  view.menu()!.props.onClose();
  expect(view.menu()).toBeUndefined();
  view.more("/demo/wt/xdev-oak")!.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 5, bottom: 9 }) } });
  expect(view.menu()!.props.at).toEqual({ x: 5, y: 9 });
});

it("Open in lists the apps from props and calls onOpenIn with the worktree path", () => {
  const opened: [string, unknown][] = [];
  const view = harness(DOTS, repos, {
    openInApps: [{ id: "vscode", label: "VS Code", command: "code", args: [] }],
    onOpenIn: (path, target) => void opened.push([path, target]),
  });
  view.main("/demo/wt/xdev-oak").props.onContextMenu({ ...event, clientX: 0, clientY: 0 });
  view.item("app:vscode")!.run!();
  view.item("fileManager")!.run!();
  expect(opened).toEqual([["/demo/wt/xdev-oak", { type: "app", id: "vscode" }], ["/demo/wt/xdev-oak", { type: "fileManager" }]]);
});

it("Copy Path, Copy Worktree Name and Copy Branch go to onCopy", () => {
  const copied: string[] = [];
  const view = harness(DOTS, repos, { onCopy: (text) => void copied.push(text) });
  view.main("/demo/wt/xdev-oak").props.onContextMenu({ ...event, clientX: 0, clientY: 0 });
  view.item("copyPath")!.run!();
  view.item("copyName")!.run!();
  view.item("copyBranch")!.run!();
  const wt = repos()[0].worktrees.find(w => w.path === "/demo/wt/xdev-oak")!;
  expect(copied).toEqual(["/demo/wt/xdev-oak", wt.name, wt.branch]);
});

it("New terminal tab here calls onNewTerminal with the worktree", () => {
  const made: string[] = [];
  const view = harness(DOTS, repos, { onNewTerminal: (w) => void made.push(w.path) });
  view.main("/demo/xdev").props.onContextMenu({ ...event, clientX: 0, clientY: 0 });
  view.item("newTerminal")!.run!();
  expect(made).toEqual(["/demo/xdev"]);
});

it("a repo row opens the project menu: Open in, Copy Path, Repo settings and Remove from xDev", () => {
  const log: string[] = [];
  const view = harness(DOTS, repos, {
    onOpenIn: (path, target) => void log.push(`open ${path} ${target.type}`),
    onCopy: (text) => void log.push(`copy ${text}`),
    onRepoSettings: (r) => void log.push(`settings ${r.id}`),
    onRemoveRepo: (r) => void log.push(`remove ${r.id}`),
  });
  const project = view.all().find(n => n.props.className === "ws-repo" && n.props["data-repo"] === "repo-2-notes")!;
  project.props.onContextMenu({ ...event, clientX: 1, clientY: 2 });
  view.item("fileManager")!.run!();
  view.item("copyPath")!.run!();
  view.item("repoSettings")!.run!();
  view.item("remove")!.run!();
  expect(log).toEqual(["open /code/notes fileManager", "copy /code/notes", "settings repo-2-notes", "remove repo-2-notes"]);
  // A repo whose folder is gone has the same menu, so it can be removed.
  const missing = view.all().find(n => n.props.className === "ws-missing")!;
  missing.props.onContextMenu({ ...event, clientX: 1, clientY: 2 });
  view.item("remove")!.run!();
  expect(log.at(-1)).toBe("remove repo-3-gone");
});

const names = (view: ReturnType<typeof harness>) =>
  view.all().filter(n => n.props.className === "ws-group-head").map(h => nodes(h.props.children).map(c => (typeof c.props.children === "string" || typeof c.props.children === "number" ? String(c.props.children) : "")).join(" ").trim());
const head = (view: ReturnType<typeof harness>, group: string) => view.all().find(n => n.props.className === "ws-group-head" && n.props["data-group"] === group)!;

const two = (): RepoView[] => {
  const [xdev] = structuredClone(DEMO_WORKSPACE.repos);
  return [xdev];
};

it("shows group headers with counts", () => {
  // Two working, one done, the primary checkout without a status.
  const view = harness({ "/demo/wt/xdev-oak": "working", "/demo/wt/xdev-elm": "working", "/demo/xdev": "done" }, two);
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

it("reports the order it draws, without the rows of a collapsed group", () => {
  const seen: string[][] = [];
  const view = harness(DOTS, repos, { onOrder: (paths) => seen.push(paths) });
  const reported = () => { hooks.effects = []; view.html(); hooks.effects.at(-1)!(); return seen.at(-1)!; };
  const all = reported();
  expect(all).toContain("/demo/wt/xdev-oak");
  expect(all).toContain("/demo/wt/xdev-elm");
  head(view, "working").props.onClick();
  const rest = reported();
  expect(rest).not.toContain("/demo/wt/xdev-oak");
  expect(rest).toContain("/demo/wt/xdev-elm");
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

const FOUND: WorktreeView = { path: "/demo/elsewhere/spike", name: "spike", branch: "spike", head: "6666666666666666666666666666666666666666", start: null, primary: false, pinned: false, detached: false, ...NO_DETAILS };

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

it("progress row renders with cancel, and a failed create offers Retry and Dismiss", () => {
  const asked = { cancel: [] as string[], retry: [] as string[], dismiss: [] as string[] };
  const view = harness(DOTS, repos, {
    pending: [
      { id: "create-1", repoId: "demo-xdev", name: "birch", from: null, state: "running" },
      { id: "create-2", repoId: "demo-xdev", name: "pine", from: null, state: "failed", error: { code: "worktree_exists", detail: "x" } },
    ],
    onCancelCreate: (id) => asked.cancel.push(id),
    onRetryCreate: (id) => asked.retry.push(id),
    onDismissCreate: (id) => asked.dismiss.push(id),
  });
  const rows = view.all().filter((n) => n.props["data-pending"] !== undefined);
  expect(rows.map((n) => n.props["data-pending"])).toEqual(["create-1", "create-2"]);
  const running = nodes(rows[0].props.children);
  expect(running.some((n) => n.props.children === "birch")).toBe(true);
  const spinner = running.find((n) => n.props.role === "progressbar")!;
  expect(spinner.props["aria-label"]).toBe(en("workspace.pending.creating", { name: "birch" }));
  const button = (list: Node[], text: string) => list.find((n) => n.type === "button" && n.props.children === text)!;
  button(running, en("workspace.pending.cancel")).props.onClick();
  expect(asked.cancel).toEqual(["create-1"]);

  const failed = nodes(rows[1].props.children);
  expect(failed.some((n) => n.props.role === "progressbar")).toBe(false);
  const why = failed.find((n) => n.props.role === "alert")!;
  expect(why.props.children).toEqual([en("workspace.pending.failed"), ` · ${en("error.worktree_exists")}`]);
  button(failed, en("workspace.pending.retry")).props.onClick();
  button(failed, en("workspace.pending.dismiss")).props.onClick();
  expect(asked).toEqual({ cancel: ["create-1"], retry: ["create-2"], dismiss: ["create-2"] });
});
