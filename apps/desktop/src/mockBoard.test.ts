import { expect, it } from "vitest";
import type { ApiError, BoardTask } from "./api";
import { createMockBoard } from "./mockBoard";

const REPO = "/repo";
const fail = async (p: Promise<unknown>): Promise<ApiError> => {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error("did not reject");
};

it("seeds five tasks, one per status, and one unreadable file", async () => {
  const board = createMockBoard();
  const list = await board.boardList(REPO);
  expect(list.tasks.map((t) => t.status).sort()).toEqual(["backlog", "done", "in-progress", "in-review", "todo"]);
  expect(list.tasks.some((t) => t.assignee === "claude")).toBe(true);
  expect(list.tasks.some((t) => t.branch)).toBe(true);
  expect(new Set(list.tasks.flatMap((t) => t.labels))).toEqual(new Set(["auth", "ui", "docs"]));
  expect(list.unreadable).toHaveLength(1);
  expect(list.unreadable[0].file).toBe(".xdev/tasks/broken.md");
  expect(board.__boardFiles(REPO)).toHaveLength(6);
});

it("create adds a file rendered like the Rust writer", async () => {
  const board = createMockBoard();
  const task = await board.boardCreate(REPO, { title: "Fix: the loop", labels: ["a", "b c"], body: "Why" });
  expect(task.id).toMatch(/^t[a-z2-7]{6}$/);
  const file = board.__boardFiles(REPO).find((f) => f.file === task.file)!;
  expect(file.text).toBe(
    `---\nid: ${task.id}\ntitle: "Fix: the loop"\nstatus: backlog\npriority: p2\nlabels: [a, b c]\ncreated: ${task.created}\nupdated: ${task.updated}\n---\nWhy\n`,
  );
  expect((await board.boardGet(REPO, task.id)).body).toBe("Why\n");
});

it("a stale expectedUpdated is a board_conflict carrying the current task", async () => {
  const board = createMockBoard();
  const [first] = (await board.boardList(REPO)).tasks;
  const moved = await board.boardUpdate(REPO, first.id, { status: "done" }, first.updated);
  expect(moved.updated).not.toBe(first.updated);
  const err = await fail(board.boardUpdate(REPO, first.id, { title: "x" }, first.updated));
  expect(err.code).toBe("board_conflict");
  expect((JSON.parse(err.detail!) as BoardTask).status).toBe("done");
  await expect(board.boardUpdate(REPO, first.id, { title: "y" })).resolves.toMatchObject({ title: "y" });
});

it("__boardEditOutside changes a task and bumps updated", async () => {
  const board = createMockBoard();
  const [first] = (await board.boardList(REPO)).tasks;
  board.__boardEditOutside(REPO, first.id, { title: "Edited outside", assignee: null });
  const now = (await board.boardGet(REPO, first.id)).task;
  expect(now.title).toBe("Edited outside");
  expect(now.updated > first.updated).toBe(true);
  expect((await fail(board.boardUpdate(REPO, first.id, { title: "mine" }, first.updated))).code).toBe("board_conflict");
});

it("bad ids, missing tasks and bad titles reject", async () => {
  const board = createMockBoard();
  expect((await fail(board.boardGet(REPO, "../x"))).code).toBe("board_bad_id");
  expect((await fail(board.boardGet(REPO, "tzzzzzz"))).code).toBe("not_found");
  expect((await fail(board.boardCreate(REPO, { title: "  ", labels: [], body: "" }))).code).toBe("io");
});

it("create many writes all or none", async () => {
  const board = createMockBoard();
  await fail(board.boardCreateMany(REPO, [{ title: "a", labels: [], body: "" }, { title: "", labels: [], body: "" }]));
  expect((await board.boardList(REPO)).tasks).toHaveLength(5);
  const made = await board.boardCreateMany(REPO, [{ title: "a", labels: [], body: "" }, { title: "b", labels: [], body: "" }]);
  expect(made).toHaveLength(2);
  expect((await board.boardList(REPO)).tasks).toHaveLength(7);
});

it("links drop for deleted tasks", async () => {
  const board = createMockBoard();
  const [first] = (await board.boardList(REPO)).tasks;
  await board.boardLinkSet(REPO, first.id, { id: "x", worktree: "/w", tabId: "1", tabTitle: "claude" });
  expect(await board.boardLinks(REPO)).toEqual([{ id: first.id, worktree: "/w", tabId: "1", tabTitle: "claude" }]);
  await board.boardDelete(REPO, first.id);
  expect(await board.boardLinks(REPO)).toEqual([]);
});
