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
