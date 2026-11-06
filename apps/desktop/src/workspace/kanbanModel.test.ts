import { expect, it, vi } from "vitest";
import type { WorktreeView } from "@/api";
import { NO_DETAILS } from "./worktreeDetails";
import { COLUMN_IDS, DRAG_THRESHOLD, NO_FILTER, dropColumn, filterCards, matchesQuery, groupByStatus, columnOf, moveCard, moveItems, pastThreshold, statusOf, type ColumnBox } from "./kanbanModel";

const wt = (path: string, status: string | null): WorktreeView => ({
  path, name: path, branch: path, head: null, start: null, primary: false, pinned: false, detached: false, ...NO_DETAILS, status: status as WorktreeView["status"],
});

it("orders the columns as the sidebar status menu does, with No status last", () => {
  expect(COLUMN_IDS).toEqual(["todo", "in-progress", "in-review", "completed", "none"]);
});

it("groups worktrees by status and keeps their order inside a column", () => {
  const cols = groupByStatus([wt("a", "todo"), wt("b", "completed"), wt("c", "todo"), wt("d", null)]);
  expect(cols.map((c) => c.items.map((w) => w.path))).toEqual([["a", "c"], [], [], ["b"], ["d"]]);
});

it("puts a status this build does not know in No status", () => {
  expect(columnOf("archived-ish")).toBe("none");
  const cols = groupByStatus([wt("a", "archived-ish")]);
  expect(cols[4].items.map((w) => w.path)).toEqual(["a"]);
});

it("lets an override win over the listed status, null meaning No status", () => {
  const cols = groupByStatus([wt("a", "todo"), wt("b", "todo")], { a: "in-review", b: null });
  expect(cols.map((c) => c.items.map((w) => w.path))).toEqual([[], [], ["a"], [], ["b"]]);
});

it("maps a column to the status it sets", () => {
  expect(statusOf("in-progress")).toBe("in-progress");
  expect(statusOf("none")).toBeNull();
});

it("starts a drag only past the threshold", () => {
  const from = { x: 100, y: 100 };
  expect(pastThreshold(from, { x: 100, y: 100 })).toBe(false);
  expect(pastThreshold(from, { x: 100 + DRAG_THRESHOLD, y: 100 })).toBe(false);
  expect(pastThreshold(from, { x: 100 + DRAG_THRESHOLD + 1, y: 100 })).toBe(true);
  expect(pastThreshold(from, { x: 105, y: 105 })).toBe(true);
});

it("finds the column under the pointer x, and none outside the board", () => {
  const boxes: ColumnBox[] = [
    { id: "todo", left: 0, right: 100 },
    { id: "in-progress", left: 110, right: 210 },
    { id: "none", left: 220, right: 320 },
  ];
  expect(dropColumn(0, boxes)).toBe("todo");
  expect(dropColumn(99.9, boxes)).toBe("todo");
  expect(dropColumn(150, boxes)).toBe("in-progress");
  expect(dropColumn(105, boxes)).toBeNull();
  expect(dropColumn(320, boxes)).toBeNull();
  expect(dropColumn(-1, boxes)).toBeNull();
});

it("lists the Move to choices with the current one checked", () => {
  const run = vi.fn();
  const items = moveItems("in-review", run);
  expect(items.map((i) => i.id)).toEqual(["status:todo", "status:in-progress", "status:in-review", "status:completed", "status:none"]);
  expect(items.map((i) => i.labelKey)).toEqual(["workspace.work.todo", "workspace.work.in-progress", "workspace.work.in-review", "workspace.work.completed", "workspace.groupBy.status.none"]);
  expect(items.filter((i) => i.checked).map((i) => i.id)).toEqual(["status:in-review"]);
  items[0].run?.();
  items[4].run?.();
  expect(run.mock.calls).toEqual([["todo"], [null]]);
});

it("checks No status for a worktree without one", () => {
  expect(moveItems(null, () => {}).filter((i) => i.checked).map((i) => i.id)).toEqual(["status:none"]);
});

function hooks(write: () => Promise<void>) {
  const log: string[] = [];
  return { log, hooks: { apply: (p: string, s: string | null) => void log.push(`apply ${p} ${s}`), settle: (p: string) => void log.push(`settle ${p}`), write: () => (log.push("write"), write()) } };
}

it("moves at once, writes, then settles", async () => {
  const h = hooks(() => Promise.resolve());
  await expect(moveCard(wt("a", "todo"), "completed", h.hooks)).resolves.toBe(true);
  expect(h.log).toEqual(["apply a completed", "write", "settle a"]);
});

it("rolls back and reports a failed write", async () => {
  const h = hooks(() => Promise.reject(new Error("nope")));
  await expect(moveCard(wt("a", "todo"), null, h.hooks)).resolves.toBe(false);
  expect(h.log).toEqual(["apply a null", "write", "settle a"]);
});

it("does nothing for a move to the column the card is in", async () => {
  const h = hooks(() => Promise.resolve());
  await expect(moveCard(wt("a", "todo"), "todo", h.hooks)).resolves.toBe(true);
  await expect(moveCard(wt("b", null), null, h.hooks)).resolves.toBe(true);
  expect(h.log).toEqual([]);
});

const card = (name: string, over: Partial<WorktreeView> = {}): WorktreeView => ({ ...wt(`/code/${name}`, null), name, branch: `feat/${name}`, ...over });

it("matches every card for an empty or blank query", () => {
  expect(matchesQuery(card("oak"), "")).toBe(true);
  expect(matchesQuery(card("oak"), "   ")).toBe(true);
});

it("matches the name and the branch, ignoring case", () => {
  expect(matchesQuery(card("oak"), "OAK")).toBe(true);
  expect(matchesQuery(card("elm"), "feat/el")).toBe(true);
  expect(matchesQuery(card("elm"), "oak")).toBe(false);
});

it("folds diacritics so plain typing finds a Vietnamese title", () => {
  expect(matchesQuery(card("oak", { title: "Sửa lỗi Việt" }), "viet")).toBe(true);
  expect(matchesQuery(card("oak", { title: "Sửa lỗi Việt" }), "  SUA LOI ")).toBe(true);
});

it("filters by the pinned flag", () => {
  const list = [card("a", { pinned: true }), card("b")];
  expect(filterCards(list, { ...NO_FILTER, pinned: true }, {}).map((w) => w.name)).toEqual(["a"]);
});

it("keeps a card with an agent open and drops one with only shells or none", () => {
  const list = [card("a"), card("b"), card("c")];
  const profiles = { "/code/a": ["claude" as const], "/code/b": ["shell-1" as const] };
  expect(filterCards(list, { ...NO_FILTER, agents: true }, profiles).map((w) => w.name)).toEqual(["a"]);
});

it("keeps a card that came from a task, and combines chips with AND", () => {
  const item = { kind: "task" as const, url: ".xdev/tasks/t.md", title: "Plan" };
  const list = [card("a", { item, pinned: true }), card("b", { item }), card("c", { pinned: true })];
  expect(filterCards(list, { ...NO_FILTER, tasks: true }, {}).map((w) => w.name)).toEqual(["a", "b"]);
  expect(filterCards(list, { ...NO_FILTER, tasks: true, pinned: true }, {}).map((w) => w.name)).toEqual(["a"]);
});

it("keeps the input order", () => {
  const list = [card("c"), card("a"), card("b")];
  expect(filterCards(list, NO_FILTER, {}).map((w) => w.name)).toEqual(["c", "a", "b"]);
});
