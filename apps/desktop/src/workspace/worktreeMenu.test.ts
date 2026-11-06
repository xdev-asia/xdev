import { expect, it, vi } from "vitest";
import type { OpenInApp, WorktreeView } from "@/api";
import type { MenuItem } from "@/ui/ContextMenu";
import { projectMenuItems, worktreeMenuItems, type WorktreeMenuContext } from "./worktreeMenu";
import { NO_DETAILS } from "@/workspace/worktreeDetails";

const wt = (over: Partial<WorktreeView> = {}): WorktreeView => ({
  path: "/code/xdev-oak", name: "xdev-oak", branch: "feat/oak", head: null, start: null, primary: false, pinned: false, detached: false, ...NO_DETAILS, ...over,
});
const APPS: OpenInApp[] = [
  { id: "vscode", label: "VS Code", command: "code", args: [] },
  { id: "app-1", label: "Cursor", command: "cursor", args: [] },
];

function ctx(over: Partial<WorktreeMenuContext> = {}) {
  const calls = { openIn: vi.fn(), copy: vi.fn(), pin: vi.fn(), unread: vi.fn(), read: vi.fn(), remove: vi.fn(), term: vi.fn() };
  const value: WorktreeMenuContext = {
    worktree: wt(), apps: APPS, unread: false,
    openIn: calls.openIn, copy: calls.copy, newTerminal: calls.term,
    onPin: calls.pin, onMarkUnread: calls.unread, onMarkRead: calls.read, onRemove: calls.remove, ...over,
  };
  return { calls, items: worktreeMenuItems(value) };
}
const find = (items: MenuItem[], id: string) => items.find((i) => i.id === id)!;
const ids = (items: MenuItem[]) => items.map((i) => i.id);

it("lists Open in with the apps in order, then the file manager and a terminal tab", () => {
  const { items } = ctx();
  const sub = find(items, "openIn").children!;
  expect(ids(sub)).toEqual(["app:vscode", "app:app-1", "openInSep", "fileManager", "newTerminal"]);
  expect(sub[0].labelKey).toBe("VS Code");
  expect(sub[1].labelKey).toBe("Cursor");
});

it("Open in app and File Manager call openIn with the target", () => {
  const { items, calls } = ctx();
  const sub = find(items, "openIn").children!;
  sub[0].run?.();
  sub[3].run?.();
  expect(calls.openIn).toHaveBeenNthCalledWith(1, { type: "app", id: "vscode" });
  expect(calls.openIn).toHaveBeenNthCalledWith(2, { type: "fileManager" });
});

it("New terminal tab here calls newTerminal and is left out without it", () => {
  const { items, calls } = ctx();
  find(items, "openIn").children!.find((i) => i.id === "newTerminal")!.run?.();
  expect(calls.term).toHaveBeenCalledOnce();
  const none = ctx({ newTerminal: undefined }).items;
  expect(ids(find(none, "openIn").children!)).not.toContain("newTerminal");
});

it("copies the absolute path, the folder name and the branch", () => {
  const { items, calls } = ctx();
  find(items, "copyPath").run?.();
  find(items, "copyName").run?.();
  find(items, "copyBranch").run?.();
  expect(calls.copy.mock.calls.map((c) => c[0])).toEqual(["/code/xdev-oak", "xdev-oak", "feat/oak"]);
});

it("Copy Branch is disabled on a detached worktree", () => {
  const { items } = ctx({ worktree: wt({ branch: null, detached: true }) });
  expect(find(items, "copyBranch").disabled).toBe(true);
});

it("keeps Pin, Mark unread and Delete wired to their callbacks", () => {
  const { items, calls } = ctx();
  find(items, "pin").run?.();
  find(items, "markUnread").run?.();
  find(items, "delete").run?.();
  expect(calls.pin).toHaveBeenCalledOnce();
  expect(calls.unread).toHaveBeenCalledOnce();
  expect(calls.remove).toHaveBeenCalledOnce();
  expect(find(items, "delete").danger).toBe(true);
});

it("a pinned row offers Unpin; an unread row offers Mark read; the primary has no Delete", () => {
  const { items, calls } = ctx({ worktree: wt({ pinned: true, primary: true }), unread: true });
  expect(find(items, "pin").labelKey).toBe("workspace.unpin");
  find(items, "markRead").run?.();
  expect(calls.read).toHaveBeenCalledOnce();
  expect(ids(items)).not.toContain("markUnread");
  expect(ids(items)).not.toContain("delete");
});

it("an empty app list still offers the file manager", () => {
  const { items } = ctx({ apps: [] });
  expect(ids(find(items, "openIn").children!)).toEqual(["fileManager", "newTerminal"]);
});

it("the project menu: Open in, Copy Path, Repo settings, then Remove from xDev", () => {
  const run = { openIn: vi.fn(), copy: vi.fn(), settings: vi.fn(), remove: vi.fn() };
  const items = projectMenuItems({ path: "/code/xdev", apps: APPS, openIn: run.openIn, copy: run.copy, repoSettings: run.settings, remove: run.remove });
  expect(ids(items)).toEqual(["openIn", "copyPath", "sep1", "repoSettings", "sep2", "remove"]);
  find(items, "copyPath").run?.();
  find(items, "repoSettings").run?.();
  find(items, "remove").run?.();
  find(items, "openIn").children![1].run?.();
  expect(run.copy).toHaveBeenCalledWith("/code/xdev");
  expect(run.settings).toHaveBeenCalledOnce();
  expect(run.remove).toHaveBeenCalledOnce();
  expect(run.openIn).toHaveBeenCalledWith({ type: "app", id: "app-1" });
  expect(find(items, "remove").danger).toBe(true);
});

it("offers Rename branch… after Details, for a worktree on a branch only", () => {
  const rename = vi.fn();
  const { items } = ctx({ onRenameBranch: rename });
  const order = ids(items);
  expect(order.indexOf("renameBranch")).toBe(order.indexOf("pin") + 1);
  find(items, "renameBranch").run?.();
  expect(rename).toHaveBeenCalledOnce();
  expect(find(items, "renameBranch").labelKey).toBe("branchRename.menu");
  // Disabled while detached (no branch to rename); left out for the primary checkout and without a handler.
  expect(find(ctx({ onRenameBranch: rename, worktree: wt({ detached: true, branch: null }) }).items, "renameBranch").disabled).toBe(true);
  expect(ids(ctx({ onRenameBranch: rename, worktree: wt({ primary: true }) }).items)).not.toContain("renameBranch");
  expect(ids(ctx().items)).not.toContain("renameBranch");
});

it("offers Sleep with nested worktrees right after Sleep, only for a parent that is awake", () => {
  const nested = vi.fn();
  const parent = ctx({ children: 2, onSleep: vi.fn(), onSleepNested: nested });
  const order = ids(parent.items);
  expect(order.indexOf("sleepNested")).toBe(order.indexOf("sleep") + 1);
  expect(find(parent.items, "sleepNested").labelKey).toBe("sleep.menu.nested");
  expect(find(parent.items, "sleepNested").disabled).toBeFalsy();
  find(parent.items, "sleepNested").run?.();
  expect(nested).toHaveBeenCalledTimes(1);

  expect(ids(ctx({ children: 0, onSleep: vi.fn(), onSleepNested: nested }).items)).not.toContain("sleepNested");
  expect(ids(ctx({ children: 2, asleep: true, onWake: vi.fn(), onSleepNested: nested }).items)).not.toContain("sleepNested");
  expect(ids(ctx({ children: 2, onSleep: vi.fn() }).items)).not.toContain("sleepNested");
  expect(find(ctx({ children: 2, nestedSleepable: false, onSleep: vi.fn(), onSleepNested: nested }).items, "sleepNested").disabled).toBe(true);
  // A parent with no awake tab still offers the nested item, because a child may be awake.
  const quiet = ctx({ children: 1, sleepable: false, onSleep: vi.fn(), onSleepNested: nested });
  expect(ids(quiet.items)).not.toContain("sleep");
  expect(ids(quiet.items)).toContain("sleepNested");
});

it("offers Sleep on an awake worktree and Wake on a sleeping one, also on the primary checkout", () => {
  const sleep = vi.fn();
  const wake = vi.fn();
  const awake = ctx({ onSleep: sleep, onWake: wake });
  expect(ids(awake.items)).toContain("sleep");
  expect(ids(awake.items)).not.toContain("wake");
  find(awake.items, "sleep").run?.();
  expect(sleep).toHaveBeenCalledTimes(1);

  const asleep = ctx({ asleep: true, onSleep: sleep, onWake: wake });
  expect(ids(asleep.items)).toContain("wake");
  expect(ids(asleep.items)).not.toContain("sleep");
  find(asleep.items, "wake").run?.();
  expect(wake).toHaveBeenCalledTimes(1);

  const primary = ctx({ worktree: wt({ primary: true }), onSleep: sleep });
  expect(ids(primary.items)).toContain("sleep");
});

it("leaves Sleep out for a worktree with no awake tab", () => {
  const none = ctx({ onSleep: vi.fn(), sleepable: false });
  expect(ids(none.items)).not.toContain("sleep");
  expect(ids(ctx({ onSleep: vi.fn(), sleepable: true }).items)).toContain("sleep");
});

it("leaves the sleep items out without handlers", () => {
  const { items } = ctx();
  expect(ids(items)).not.toContain("sleep");
  expect(ids(items)).not.toContain("wake");
});

it("offers Set parent worktree… without a parent and Change parent worktree… with one, disabled at 0 candidates", () => {
  const set = vi.fn();
  const none = ctx({ onSetParent: set, canSetParent: true });
  expect(find(none.items, "setParent").labelKey).toBe("lineage.set");
  find(none.items, "setParent").run?.();
  expect(set).toHaveBeenCalledOnce();
  const has = ctx({ onSetParent: set, canSetParent: true, parentPath: "/code/xdev-main-feature" });
  expect(find(has.items, "setParent").labelKey).toBe("lineage.change");
  expect(find(ctx({ onSetParent: set, canSetParent: false }).items, "setParent").disabled).toBe(true);
  expect(ids(ctx().items)).not.toContain("setParent");
  expect(ids(ctx({ worktree: wt({ primary: true }), onSetParent: set, canSetParent: true }).items)).not.toContain("setParent");
});

it("offers Open parent worktree only with a shown parent and Remove from parent only with a parent", () => {
  const open = vi.fn();
  const remove = vi.fn();
  const full = ctx({ parentPath: "/p", onOpenParent: open, onRemoveParent: remove });
  find(full.items, "openParent").run?.();
  find(full.items, "removeParent").run?.();
  expect(open).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledOnce();
  expect(find(full.items, "openParent").labelKey).toBe("lineage.open");
  expect(find(full.items, "removeParent").labelKey).toBe("lineage.remove");
  // The parent is hidden by a filter: no Open handler.
  expect(ids(ctx({ parentPath: "/p", onRemoveParent: remove }).items)).not.toContain("openParent");
  const orphan = ids(ctx({ onOpenParent: open, onRemoveParent: remove }).items);
  expect(orphan).not.toContain("openParent");
  expect(orphan).not.toContain("removeParent");
});

it("offers Delete with nested worktrees… only when the row has children", () => {
  const nested = vi.fn();
  expect(ids(ctx({ children: 0, onDeleteNested: nested }).items)).not.toContain("deleteNested");
  const some = ctx({ children: 2, onDeleteNested: nested });
  find(some.items, "deleteNested").run?.();
  expect(nested).toHaveBeenCalledOnce();
  expect(find(some.items, "deleteNested").danger).toBe(true);
  expect(find(some.items, "deleteNested").labelKey).toBe("lineage.deleteNested");
});

it("Move to status has five radio items with the current one checked, and is absent on the primary checkout", () => {
  const move = vi.fn();
  const { items } = ctx({ worktree: wt({ status: "in-review" }), onMoveStatus: move });
  const sub = find(items, "moveStatus").children!;
  expect(find(items, "moveStatus").labelKey).toBe("workspace.status.move");
  expect(ids(sub)).toEqual(["status:todo", "status:in-progress", "status:in-review", "status:completed", "status:none"]);
  expect(sub.map((i) => i.checked)).toEqual([false, false, true, false, false]);
  expect(sub.map((i) => i.labelKey)).toEqual(["workspace.work.todo", "workspace.work.in-progress", "workspace.work.in-review", "workspace.work.completed", "workspace.status.none"]);
  sub[0].run?.();
  sub[4].run?.();
  expect(move.mock.calls).toEqual([["todo"], [null]]);
  expect(find(ctx({ worktree: wt({ status: null }), onMoveStatus: move }).items, "moveStatus").children!.map((i) => i.checked)).toEqual([false, false, false, false, true]);
  expect(ids(ctx({ worktree: wt({ primary: true }), onMoveStatus: move }).items)).not.toContain("moveStatus");
  expect(ids(ctx().items)).not.toContain("moveStatus");
});

it("offers Check out branch… when a handler is given, disabled while detached", () => {
  const checkout = vi.fn();
  const { items } = ctx({ onCheckoutBranch: checkout });
  find(items, "checkoutBranch").run?.();
  expect(checkout).toHaveBeenCalledOnce();
  expect(find(items, "checkoutBranch").labelKey).toBe("checkout.menu");
  expect(find(ctx({ onCheckoutBranch: checkout, worktree: wt({ detached: true, branch: null }) }).items, "checkoutBranch").disabled).toBe(true);
  expect(ids(ctx().items)).not.toContain("checkoutBranch");
});
