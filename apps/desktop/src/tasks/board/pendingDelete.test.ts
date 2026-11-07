import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getToasts, resetToastsForTests } from "@/workspace/toastStore";
import { deleteTask, flushPendingDeletes, isPendingDelete, pendingDeleteVersion, resetPendingDeletesForTests, subscribePendingDeletes, undoDelete, UNDO_MS } from "./pendingDelete";

const REPO = "/repo";
const TEXT = { deleted: "Task deleted", undo: "Undo", failed: "Could not delete the task." };
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function api(fail = false) {
  return { boardDelete: vi.fn(async (_repo: string, _id: string) => { if (fail) throw { code: "io" }; }) };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetToastsForTests();
  resetPendingDeletesForTests();
});
afterEach(() => {
  vi.useRealTimers();
});

it("the undo window is the toast's 8 seconds", () => {
  expect(UNDO_MS).toBe(8000);
});

it("delete hides the task at once and shows a toast with Undo; the file goes only when the window ends", async () => {
  const a = api();
  const committed = vi.fn(async () => {});
  const heard = vi.fn();
  subscribePendingDeletes(heard);
  deleteTask(a, REPO, "t1", TEXT, committed);
  expect(isPendingDelete(REPO, "t1")).toBe(true);
  expect(isPendingDelete("/other", "t1")).toBe(false);
  expect(heard).toHaveBeenCalled();
  expect(getToasts()).toEqual([expect.objectContaining({ text: "Task deleted", actions: [expect.objectContaining({ label: "Undo" })] })]);
  vi.advanceTimersByTime(UNDO_MS - 1);
  await settle();
  expect(a.boardDelete).not.toHaveBeenCalled();
  expect(isPendingDelete(REPO, "t1")).toBe(true);
  vi.advanceTimersByTime(1);
  await settle();
  expect(a.boardDelete).toHaveBeenCalledExactlyOnceWith(REPO, "t1");
  // Stays hidden until the board has read the list without it.
  expect(committed).toHaveBeenCalledOnce();
  expect(isPendingDelete(REPO, "t1")).toBe(false);
  expect(getToasts()).toEqual([]);
});

it("Undo before the window ends restores the task and never touches the file", async () => {
  const a = api();
  deleteTask(a, REPO, "t1", TEXT);
  vi.advanceTimersByTime(UNDO_MS - 1000);
  const before = pendingDeleteVersion();
  getToasts()[0]!.actions[0]!.run();
  expect(pendingDeleteVersion()).not.toBe(before);
  expect(isPendingDelete(REPO, "t1")).toBe(false);
  expect(getToasts()).toEqual([]);
  vi.advanceTimersByTime(UNDO_MS * 2);
  await settle();
  expect(a.boardDelete).not.toHaveBeenCalled();
});

it("undo of a task that is not pending does nothing", () => {
  expect(undoDelete(REPO, "nope")).toBe(false);
});

it("deleting the same task twice keeps one timer and one toast", async () => {
  const a = api();
  deleteTask(a, REPO, "t1", TEXT);
  vi.advanceTimersByTime(3000);
  deleteTask(a, REPO, "t1", TEXT);
  expect(getToasts()).toHaveLength(1);
  vi.advanceTimersByTime(UNDO_MS - 3000);
  await settle();
  expect(a.boardDelete).toHaveBeenCalledOnce();
});

it("two tasks each get their own window and toast", async () => {
  const a = api();
  deleteTask(a, REPO, "t1", TEXT);
  vi.advanceTimersByTime(2000);
  deleteTask(a, REPO, "t2", TEXT);
  expect(getToasts()).toHaveLength(2);
  vi.advanceTimersByTime(UNDO_MS - 2000);
  await settle();
  expect(a.boardDelete.mock.calls).toEqual([[REPO, "t1"]]);
  expect(isPendingDelete(REPO, "t2")).toBe(true);
  vi.advanceTimersByTime(2000);
  await settle();
  expect(a.boardDelete.mock.calls).toEqual([[REPO, "t1"], [REPO, "t2"]]);
});

it("a failed delete shows the task again and says so", async () => {
  const a = api(true);
  const committed = vi.fn(async () => {});
  deleteTask(a, REPO, "t1", TEXT, committed);
  vi.advanceTimersByTime(UNDO_MS);
  await settle();
  expect(isPendingDelete(REPO, "t1")).toBe(false);
  expect(committed).toHaveBeenCalledOnce();
  expect(getToasts().map((t) => t.text)).toEqual(["Could not delete the task."]);
});

it("flush deletes what is waiting now, as the window closes", async () => {
  const a = api();
  deleteTask(a, REPO, "t1", TEXT);
  deleteTask(a, REPO, "t2", TEXT);
  flushPendingDeletes();
  await settle();
  expect(a.boardDelete.mock.calls).toEqual([[REPO, "t1"], [REPO, "t2"]]);
  vi.advanceTimersByTime(UNDO_MS * 2);
  await settle();
  expect(a.boardDelete).toHaveBeenCalledTimes(2);
});

it("a delete on its way runs once and can no longer be undone", async () => {
  let finish!: () => void;
  const a = { boardDelete: vi.fn(() => new Promise<void>((r) => { finish = r; })) };
  deleteTask(a, REPO, "t1", TEXT);
  vi.advanceTimersByTime(UNDO_MS);
  flushPendingDeletes();
  expect(undoDelete(REPO, "t1")).toBe(false);
  expect(isPendingDelete(REPO, "t1")).toBe(true);
  finish();
  await settle();
  expect(a.boardDelete).toHaveBeenCalledOnce();
  expect(isPendingDelete(REPO, "t1")).toBe(false);
});
