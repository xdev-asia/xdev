import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RepoView, SidebarItem, SidebarPrefs, WorktreeView } from "@/api";
import { SIDEBAR_PREFS_DEFAULTS } from "@/mockSettings";
import { Badge } from "@xdev-asia/ui";
import { translate } from "@/i18n";
import { ago } from "./ago";
import { DEMO_WORKSPACE } from "@/mockWorkspace";
import { ContextMenu, type MenuItem } from "@/ui/ContextMenu";
import { WorktreeList, type WorktreeListProps } from "./WorktreeList";
import { RepoBadge } from "./RepoBadge";
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
  id: "repo-2-notes", shortName: "notes", path: "/code/notes", baseRef: "main", worktreeRoot: "/code/wt", setupPolicy: "ask", scriptSource: "auto", localSetup: "", localArchive: "", docsDir: "docs", color: null, icon: null, ghAccount: null, localIssueCommand: "", missing: false,
  worktrees: [{ path: "/code/notes", name: "notes", branch: null, head: null, start: null, primary: true, pinned: false, detached: true, ...NO_DETAILS }],
  found: [],
};
// A repo whose folder is gone comes back with no worktrees.
const gone: RepoView = { id: "repo-3-gone", shortName: "gone", path: "/code/gone", baseRef: "main", worktreeRoot: "/code/wt", setupPolicy: "ask", scriptSource: "auto", localSetup: "", localArchive: "", docsDir: "docs", color: null, icon: null, ghAccount: null, localIssueCommand: "", missing: true, worktrees: [], found: [] };
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
      items: list().map((repo): SidebarItem => ({ kind: "repo", repo, kept: [] })),
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
  const view = withData({ items: structuredClone(repos()).map(r => ({ ...r, worktrees: r.worktrees.map(w => w.name === "oak" ? { ...w, name: long, branch: long } : w) })).map((repo): SidebarItem => ({ kind: "repo", repo, kept: [] })) });
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

// Sidebar lifecycle: nesting, archived branches, folders and keyboard order.
const asItem = (repo: RepoView, kept: Extract<SidebarItem, { kind: "repo" }>["kept"] = []): SidebarItem => ({ kind: "repo", repo, kept });

it("a child worktree sits under its parent and folds away", () => {
  const [xdev] = repos();
  const [a, b] = xdev.worktrees.filter(w => !w.primary);
  // `repos()` pins elm, and a pinned row leaves its status section: unpin it so the two share one.
  const nested = { ...xdev, worktrees: xdev.worktrees.map(w => (w.path === b.path ? { ...w, parent: a.path, pinned: false } : w)) };
  // Same status for both, so they share a section and the child nests.
  const dots = { [a.path]: "idle", [b.path]: "idle" } as typeof DOTS;
  const view = harness(dots, repos, { items: [asItem(nested)] });
  expect(view.html()).toContain("ws-wt-child");
  expect(view.html()).toContain("ws-wt-kids");
});

it("archived branches list under their repo with a restore button", () => {
  const [xdev] = repos();
  const entry = { branch: "old", path: "/x/old", title: "Old work", keptMs: 1 } as never;
  const view = harness(DOTS, repos, { items: [asItem(xdev, [{ entry, ahead: 0, archivedShown: true }] as never)], onRestore: () => {} });
  expect(view.html()).toContain("ws-archived");
  expect(view.html()).toContain(en("archived.title", { count: 1 }));
});

it("a plain folder shows as a row and a group lists its members", () => {
  const [xdev] = repos();
  const folder = { id: "f1", path: "/code/plain", name: "plain" } as never;
  const items: SidebarItem[] = [
    { kind: "folder", folder },
    { kind: "group", group: { id: "g1", name: "Team", members: [xdev.id] }, items: [asItem(xdev)] },
  ];
  const html = harness(DOTS, repos, { items }).html();
  expect(html).toContain("ws-folder");
  expect(html).toContain("Team");
});

it("alt+arrow on a repo row asks for a new order", () => {
  const [xdev, notes2] = repos();
  const seen: string[][] = [];
  const view = harness(DOTS, repos, { items: [asItem(xdev), asItem(notes2)], onReorder: (ids: string[]) => void seen.push(ids) });
  const row = view.all().find(n => n.props["data-repo"] === notes2.id && /ws-repo/.test(n.props.className ?? ""))!;
  const target = {};
  row.props.onKeyDown({ key: "ArrowUp", altKey: true, target, currentTarget: target, preventDefault() {} });
  expect(seen).toEqual([[notes2.id, xdev.id]]);
});

// Project identity and the Pinned group
const pinGroup = (view: ReturnType<typeof harness>) => view.all().find(n => n.props.className === "ws-group ws-group-pinned");
const pinHead = (view: ReturnType<typeof harness>) => view.all().find(n => n.props.className === "ws-group-head" && n.props["data-group"] === "pinned")!;
const pathsIn = (node: Node | undefined) => nodes(node?.props.children).filter(n => /^ws-wt( |$)/.test(n.props.className ?? "")).map(n => n.props["data-path"]);
const countOf = (html: string, path: string) => html.split(`data-path="${path}"`).length - 1;

it("nothing pinned: there is no Pinned group", () => {
  const view = harness(DOTS, two);
  expect(pinGroup(view)).toBeUndefined();
  expect(view.html()).not.toContain('data-group="pinned"');
});

it("a pinned worktree moves to a Pinned group at the top and is not repeated under its status", () => {
  const view = harness(DOTS, repos);
  const group = pinGroup(view)!;
  expect(group).toBeDefined();
  // First of the groups, ahead of the status sections.
  expect(view.all().find(n => n.props.className === "ws-groups")!.props.children[0].key).toBe("pinned");
  expect(pathsIn(group)).toEqual(["/demo/wt/xdev-elm"]);
  expect(nodes(pinHead(view).props.children).some(n => n.props.children === en("sidebar.pinned.title"))).toBe(true);
  expect(nodes(pinHead(view).props.children).some(n => n.props.className === "ws-group-count" && n.props.children === 1)).toBe(true);
  // elm was failed, so its status section is gone with it: one row, in the Pinned group only.
  const html = view.html();
  expect(countOf(html, "/demo/wt/xdev-elm")).toBe(1);
  expect(countOf(html, "/demo/wt/xdev-oak")).toBe(1);
  expect(view.all().some(n => n.props.className === "ws-group-head" && n.props["data-group"] === "needs-you")).toBe(false);
});

it("pin moves a row up and unpin returns it to its status section", () => {
  let pinned = false;
  const list = (): RepoView[] => {
    const [xdev] = structuredClone(DEMO_WORKSPACE.repos);
    xdev.worktrees[1].pinned = pinned;
    return [xdev];
  };
  const view = harness({ "/demo/wt/xdev-oak": "working" }, list);
  expect(pinGroup(view)).toBeUndefined();
  const working = () => view.all().find(n => n.props.className === "ws-group" && n.props["data-group"] === "working");
  expect(pathsIn(working())).toEqual(["/demo/wt/xdev-oak"]);

  pinned = true;
  expect(pathsIn(pinGroup(view))).toEqual(["/demo/wt/xdev-oak"]);
  expect(working()).toBeUndefined();
  expect(countOf(view.html(), "/demo/wt/xdev-oak")).toBe(1);
  // The row menu says Unpin.
  view.main("/demo/wt/xdev-oak").props.onContextMenu(event);
  expect(view.item("pin")!.labelKey).toBe("workspace.unpin");

  pinned = false;
  expect(pinGroup(view)).toBeUndefined();
  expect(pathsIn(working())).toEqual(["/demo/wt/xdev-oak"]);
});

it("rows of the Pinned group carry a project chip, even with one project", () => {
  const view = harness(DOTS, () => {
    const [xdev] = structuredClone(DEMO_WORKSPACE.repos);
    xdev.worktrees[2].pinned = true;
    return [xdev];
  });
  const chips = nodes(view.row("/demo/wt/xdev-elm").props.children).filter(n => n.props["data-project-chip"] !== undefined);
  expect(chips).toHaveLength(1);
  expect(chips[0].props["data-project-chip"]).toBe("demo-xdev");
  const badge = nodes(chips[0].props.children).find(n => n.type === RepoBadge)!;
  expect(badge.props.repo).toMatchObject({ shortName: "xdev", color: "teal", icon: { kind: "emoji", value: "🚀" } });
  expect(renderToStaticMarkup(chips[0])).toContain("xdev");
  // A row outside the group has no chip while there is one project.
  expect(nodes(view.row("/demo/wt/xdev-oak").props.children).some(n => n.props["data-project-chip"] !== undefined)).toBe(false);
});

it("with several projects every row shows its project chip", () => {
  const view = harness(DOTS, repos);
  const chip = (path: string) => nodes(view.row(path).props.children).find(n => n.props["data-project-chip"] !== undefined);
  expect(chip("/demo/wt/xdev-oak")!.props["data-project-chip"]).toBe("demo-xdev");
  expect(chip("/code/notes")!.props["data-project-chip"]).toBe("repo-2-notes");
});

it("each project heading carries the project's badge", () => {
  const view = harness();
  const heading = view.all().find(n => n.props.className === "ws-repo" && n.props["data-repo"] === "demo-xdev")!;
  const badge = nodes(heading.props.children).find(n => n.type === RepoBadge)!;
  expect(badge.props.repo.id).toBe("demo-xdev");
  const plain = view.all().find(n => n.props.className === "ws-repo" && n.props["data-repo"] === "repo-2-notes")!;
  expect(nodes(plain.props.children).find(n => n.type === RepoBadge)!.props.repo.color).toBeNull();
});

it("the shown order puts the Pinned rows first, and selection works on them", () => {
  const seen: string[][] = [];
  const picks: unknown[] = [];
  const view = harness(DOTS, repos, { onOrder: (paths) => seen.push(paths), onPick: (w, mods) => void picks.push([w.path, mods]) });
  const reported = () => { hooks.effects = []; view.html(); hooks.effects.at(-1)!(); return seen.at(-1)!; };
  expect(reported()).toEqual(["/demo/wt/xdev-elm", "/demo/wt/xdev-oak", "/demo/xdev", "/code/notes"]);
  // Ctrl and Shift clicks on a Pinned row go to onPick, like any row.
  view.main("/demo/wt/xdev-elm").props.onClick({ ctrlKey: true, shiftKey: false });
  view.main("/demo/wt/xdev-elm").props.onClick({ ctrlKey: false, shiftKey: true });
  expect(picks).toEqual([["/demo/wt/xdev-elm", { toggle: true, range: false }], ["/demo/wt/xdev-elm", { toggle: false, range: true }]]);
  // Folding the Pinned group takes its rows out of the order.
  pinHead(view).props.onClick();
  expect(pinHead(view).props["aria-expanded"]).toBe(false);
  expect(reported()).toEqual(["/demo/wt/xdev-oak", "/demo/xdev", "/code/notes"]);
});

it("a worktree the CLI changed shows a by CLI chip beside its status", () => {
  const marked = (): RepoView[] => {
    const list = repos();
    Object.assign(list[0].worktrees[1], { status: "in-review", setByCliMs: 1_000 });
    return list;
  };
  const view = harness(DOTS, marked, { now: 61_000 });
  const path = marked()[0].worktrees[1].path;
  const chip = view.inRow(path).find((n) => n.props.className === "ws-wt-cli")!;
  expect(chip.props.children).toBe(translate("en", "cli.mark"));
  const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
  expect(chip.props.title).toBe(t("cli.mark.title", { ago: ago(1_000, 61_000, t) }));
  const meta = view.inRow(path).find((n) => n.props.className === "ws-wt-meta")!;
  const kids = nodes(meta.props.children).map((n) => n.props.className);
  expect(kids.indexOf("ws-wt-cli")).toBe(kids.indexOf("ws-chip ws-wt-status") + 1);
  // Others have none.
  expect(view.all().filter((n) => n.props.className === "ws-wt-cli")).toHaveLength(1);
});

const prefsWith = (extra: Partial<SidebarPrefs>): SidebarPrefs => ({ ...SIDEBAR_PREFS_DEFAULTS, ...extra });

it("a compact row has no sub line and no meta line", () => {
  const view = withData({ prefs: prefsWith({ compactCards: true }) });
  const oak = nodes(view.row("/demo/wt/xdev-oak").props.children);
  expect(oak.some(n => n.props.className === "ws-wt-sub")).toBe(false);
  expect(oak.some(n => n.props.className === "ws-wt-meta")).toBe(false);
  // The line counts and the time stay inline on the one line.
  expect(oak.some(n => n.props.className === "ws-stat")).toBe(true);
  expect(oak.some(n => n.props.className === "ws-wt-time")).toBe(true);
  expect(view.all().find(n => n.props.className === "ws-worktrees")!.props["data-layout"]).toBe("compact");
});

it("a detailed row drops the part whose property is off", () => {
  const on = withData();
  expect(part(on, "/demo/wt/xdev-oak", "ws-wt-branch")).toHaveLength(1);
  const off = withData({ prefs: prefsWith({ card: { ...SIDEBAR_PREFS_DEFAULTS.card, branch: false, time: false, diffStat: false } }) });
  expect(part(off, "/demo/wt/xdev-oak", "ws-wt-branch")).toHaveLength(0);
  expect(nodes(off.row("/demo/wt/xdev-oak").props.children).some(n => n.props.className === "ws-wt-time")).toBe(false);
  expect(nodes(off.row("/demo/wt/xdev-oak").props.children).some(n => n.props.className === "ws-stat")).toBe(false);
  expect(off.all().find(n => n.props.className === "ws-worktrees")!.props["data-layout"]).toBeUndefined();
});

it("group by project draws a section per repo, in repo order", () => {
  const view = harness(DOTS, repos, { prefs: prefsWith({ groupBy: "project" }) });
  const keys = view.all().filter(n => n.props.className === "ws-group").map(n => n.props["data-group"]);
  expect(keys).toEqual(["project:demo-xdev", "project:repo-2-notes"]);
});

it("group by none draws the rows without a heading", () => {
  const view = harness(DOTS, repos, { prefs: prefsWith({ groupBy: "none" }) });
  expect(view.all().filter(n => n.props.className === "ws-group-head" && n.props["data-group"] !== "pinned")).toHaveLength(0);
  expect(view.html()).toContain("/demo/wt/xdev-oak");
});

it("group by status and by pull request use their own keys, and a fold is scoped to the mode", () => {
  const prs = { "/demo/wt/xdev-oak": { pr: { number: 7, url: "u", state: "open" as const, title: "t", base: "main", head: "h" }, checks: [] } };
  const view = harness(DOTS, repos, { prefs: prefsWith({ groupBy: "pr" }), prs });
  const keys = view.all().filter(n => n.props.className === "ws-group").map(n => n.props["data-group"]);
  expect(keys).toContain("pr:open");
  expect(keys).toContain("pr:none");
  const status = harness(DOTS, repos, { prefs: prefsWith({ groupBy: "status" }) });
  expect(status.all().filter(n => n.props.className === "ws-group").map(n => n.props["data-group"])).toContain("status:none");
});

it("sort recent changes the order passed to onOrder", () => {
  const seen: string[][] = [];
  const activity = { "/demo/wt/xdev-elm": NOW - 1000, "/demo/wt/xdev-oak": NOW - 9000 };
  const order = (sort: "manual" | "recent") => {
    const view = harness(DOTS, repos, { prefs: prefsWith({ groupBy: "none", sort }), activity, onOrder: (p) => seen.push(p) });
    hooks.effects = [];
    view.html();
    hooks.effects.at(-1)!();
    return seen.at(-1)!;
  };
  const manual = order("manual");
  const recent = order("recent");
  expect(recent.indexOf("/demo/wt/xdev-elm")).toBeLessThan(recent.indexOf("/demo/wt/xdev-oak"));
  expect(recent.slice(0, 2)).toEqual(["/demo/wt/xdev-elm", "/demo/wt/xdev-oak"]);
  expect([...recent].sort()).toEqual([...manual].sort());
});

it("group by project with sort recent keeps the repo order and sorts the rows inside a section", () => {
  const seen: string[][] = [];
  // The notes repo has the newest output, but its section stays second.
  const activity = { "/code/notes": NOW - 100, "/demo/wt/xdev-elm": NOW - 1000, "/demo/wt/xdev-oak": NOW - 9000 };
  const view = harness(DOTS, repos, { prefs: prefsWith({ groupBy: "project", sort: "recent" }), activity, onOrder: (p) => seen.push(p) });
  const keys = view.all().filter(n => n.props.className === "ws-group").map(n => n.props["data-group"]);
  expect(keys).toEqual(["project:demo-xdev", "project:repo-2-notes"]);
  hooks.effects = [];
  view.html();
  hooks.effects.at(-1)!();
  const order = seen.at(-1)!;
  expect(order.indexOf("/demo/wt/xdev-elm")).toBeLessThan(order.indexOf("/demo/wt/xdev-oak"));
  expect(order.indexOf("/demo/wt/xdev-oak")).toBeLessThan(order.indexOf("/code/notes"));
});

it("sort recent does not move rows when new output arrives", () => {
  const seen: string[][] = [];
  const activity: Record<string, number> = { "/demo/wt/xdev-elm": NOW - 1000, "/demo/wt/xdev-oak": NOW - 9000 };
  const view = harness(DOTS, repos, { prefs: prefsWith({ groupBy: "none", sort: "recent" }), activity, onOrder: (p) => seen.push(p) });
  const order = () => {
    hooks.effects = [];
    view.html();
    hooks.effects.at(-1)!();
    return seen.at(-1)!;
  };
  const before = order();
  activity["/code/notes"] = NOW + 1;
  expect(order()).toEqual(before);
  expect(before.at(-1)).toBe("/code/notes");
});

it("a sleeping worktree shows a badge and its menu offers Wake; an awake one offers Sleep", () => {
  const slept: string[] = [];
  const woke: string[] = [];
  const view = harness(DOTS, repos, {
    asleep: { "/demo/wt/xdev-oak": true },
    onSleep: (w) => void slept.push(w.path),
    onWake: (w) => void woke.push(w.path),
  });
  const badge = view.inRow("/demo/wt/xdev-oak").find((n) => n.type === Badge);
  expect(badge).toBeDefined();
  expect(view.inRow("/demo/wt/xdev-elm").find((n) => n.type === Badge)).toBeUndefined();

  view.main("/demo/wt/xdev-oak").props.onContextMenu(event);
  expect(view.item("sleep")).toBeUndefined();
  view.item("wake")!.run!();
  view.main("/demo/xdev").props.onContextMenu(event);
  view.item("sleep")!.run!();
  expect(woke).toEqual(["/demo/wt/xdev-oak"]);
  expect(slept).toEqual(["/demo/xdev"]);
});

it("the menu of a child row has the lineage items; the parent's has Delete with nested worktrees", () => {
  const [xdev] = repos();
  const [a, b] = xdev.worktrees.filter(w => !w.primary);
  const nested = { ...xdev, worktrees: xdev.worktrees.map(w => (w.path === b.path ? { ...w, parent: a.path, pinned: false } : w)) };
  const dots = { [a.path]: "idle", [b.path]: "idle" } as typeof DOTS;
  const done = { parent: [] as string[], removed: [] as string[], nested: [] as string[], status: [] as unknown[] };
  const view = harness(dots, repos, {
    items: [asItem(nested)],
    onSetParent: (w) => void done.parent.push(w.path),
    onRemoveParent: (w) => void done.removed.push(w.path),
    onDeleteNested: (w) => void done.nested.push(w.path),
    onMoveStatus: (w, s) => void done.status.push([w.path, s]),
  });
  view.main(b.path).props.onContextMenu(event);
  expect(view.item("setParent")!.labelKey).toBe("lineage.change");
  view.item("setParent")!.run!();
  view.item("removeParent")!.run!();
  view.item("openParent")!.run!();
  view.item("status:todo")!.run!();
  expect(view.item("status:none")!.checked).toBe(true);
  expect(view.item("deleteNested")).toBeUndefined();
  expect(done.parent).toEqual([b.path]);
  expect(done.removed).toEqual([b.path]);
  expect(view.calls.select.map(w => w.path)).toEqual([a.path]);
  expect(done.status).toEqual([[b.path, "todo"]]);

  view.main(a.path).props.onContextMenu(event);
  expect(view.item("setParent")!.labelKey).toBe("lineage.set");
  expect(view.item("setParent")!.disabled).toBe(true);
  expect(view.item("openParent")).toBeUndefined();
  view.item("deleteNested")!.run!();
  expect(done.nested).toEqual([a.path]);
});
