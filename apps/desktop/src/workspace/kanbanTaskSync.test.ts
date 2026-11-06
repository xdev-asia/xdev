import { expect, it, vi } from "vitest";
import { syncTaskStatus } from "@/tasks/board/boardModel";

const item = { kind: "task", url: ".xdev/tasks/tbk2a3c.md" };
const task = {} as never;

it("moving a task's worktree writes the task status, with no expected updated", async () => {
  const boardUpdate = vi.fn(async () => task);
  await syncTaskStatus({ boardUpdate }, "/repo", item, "in-review");
  expect(boardUpdate).toHaveBeenCalledTimes(1);
  expect(boardUpdate).toHaveBeenCalledWith("/repo", "tbk2a3c", { status: "in-review" });
});

it("completed becomes done and no status becomes backlog", async () => {
  const boardUpdate = vi.fn(async () => task);
  await syncTaskStatus({ boardUpdate }, "/repo", item, "completed");
  await syncTaskStatus({ boardUpdate }, "/repo", item, null);
  expect(boardUpdate.mock.calls.map((c) => (c as unknown[])[2])).toEqual([{ status: "done" }, { status: "backlog" }]);
});

it("a worktree that is not from a task writes nothing", async () => {
  const boardUpdate = vi.fn(async () => task);
  await syncTaskStatus({ boardUpdate }, "/repo", { kind: "pr", url: "https://x/1" }, "todo");
  await syncTaskStatus({ boardUpdate }, "/repo", null, "todo");
  await syncTaskStatus({ boardUpdate }, null, item, "todo");
  expect(boardUpdate).not.toHaveBeenCalled();
});

it("a failed write calls onError and does not throw", async () => {
  const onError = vi.fn();
  await expect(syncTaskStatus({ boardUpdate: vi.fn(async () => Promise.reject({ code: "board_conflict" })) }, "/repo", item, "todo", onError)).resolves.toBeUndefined();
  expect(onError).toHaveBeenCalledTimes(1);
});
