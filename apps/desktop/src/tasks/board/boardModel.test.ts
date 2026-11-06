import { expect, it, vi } from "vitest";
import type { WorktreeView } from "@/api";
import { task } from "./fixtures";
import { byPriority, groupByStatus, idFromFile, keyMove, moveTask, slug, startPrompt, startTask, workToStatus, type StartDeps } from "./boardModel";

it("groups the tasks into the five columns in order, keeping their order inside", () => {
  const cols = groupByStatus([task("a", { status: "done" }), task("b", { status: "backlog" }), task("c", { status: "todo" }), task("d", { status: "todo" }), task("e", { status: "in-review" })]);
  expect(cols.map((c) => c.status)).toEqual(["backlog", "todo", "in-progress", "in-review", "done"]);
  expect(cols.map((c) => c.tasks.map((t) => t.id))).toEqual([["b"], ["c", "d"], [], ["e"], ["a"]]);
});

it("moveTask changes one status and leaves the rest; a move to the same column keeps the array", () => {
  const list = [task("a"), task("b")];
  const moved = moveTask(list, "a", "done");
  expect(moved.map((t) => t.status)).toEqual(["done", "todo"]);
  expect(list[0].status).toBe("todo");
  expect(moveTask(list, "a", "todo")).toBe(list);
  expect(moveTask(list, "zz", "done")).toBe(list);
});

it("Alt+Left and Alt+Right step one column and stop at the ends", () => {
  expect(keyMove("ArrowRight", true, "todo")).toBe("in-progress");
  expect(keyMove("ArrowLeft", true, "todo")).toBe("backlog");
  expect(keyMove("ArrowLeft", true, "backlog")).toBeNull();
  expect(keyMove("ArrowRight", true, "done")).toBeNull();
  expect(keyMove("ArrowRight", false, "todo")).toBeNull();
  expect(keyMove("Enter", true, "todo")).toBeNull();
});

it("sorts by priority, then the newest update", () => {
  const rows = [task("a", { priority: "p2", updated: "2026-11-01" }), task("b", { priority: "p0" }), task("c", { priority: "p2", updated: "2026-11-03" })];
  expect(rows.sort(byPriority).map((t) => t.id)).toEqual(["b", "c", "a"]);
});

it("slug is lowercase ASCII, cut at 40, and never empty", () => {
  expect(slug("Fix the login redirect loop!")).toBe("fix-the-login-redirect-loop");
  expect(slug("  --Ünï cödé  ")).toBe("n-c-d");
  expect(slug("")).toBe("task");
  expect(slug("日本語")).toBe("task");
  const long = slug("a".repeat(39) + " bbbb");
  expect(long.length).toBeLessThanOrEqual(40);
  expect(long.endsWith("-")).toBe(false);
  expect(slug("x".repeat(80))).toHaveLength(40);
});

it("workToStatus maps the worktree statuses back", () => {
  expect(workToStatus(null)).toBe("backlog");
  expect(workToStatus("todo")).toBe("todo");
  expect(workToStatus("in-progress")).toBe("in-progress");
  expect(workToStatus("in-review")).toBe("in-review");
  expect(workToStatus("completed")).toBe("done");
});

it("idFromFile takes the file name without .md", () => {
  expect(idFromFile(".xdev/tasks/t7k2m9q.md")).toBe("t7k2m9q");
  expect(idFromFile("t7k2m9q.md")).toBe("t7k2m9q");
});

it("the prompt names the file and the title", () => {
  expect(startPrompt({ id: "tx", title: "Do it" })).toBe('Work on the task in .xdev/tasks/tx.md: "Do it". Read the file first. When you finish, set its status to in-review.');
});

function deps(over: Partial<StartDeps> = {}) {
  const calls: string[] = [];
  const d = {
    worktreeCreate: vi.fn(async () => (calls.push("create"), { worktree: { path: "/wt/fix", branch: "fix-it" } as WorktreeView, shared: [] })),
    worktreeDetails: vi.fn(async () => void calls.push("details")),
    boardLinkSet: vi.fn(async () => void calls.push("link")),
    boardUpdate: vi.fn(async () => (calls.push("update"), task("ta"))),
    onStart: vi.fn(async () => (calls.push("start"), { tabId: "tab1", tabTitle: "claude" })),
    current: { path: "/wt/main", branch: "main" },
    ...over,
  } satisfies StartDeps;
  return { d, calls };
}
const repo = { id: "r1", path: "/repo" };
const t = task("ta", { title: "Fix it", file: ".xdev/tasks/ta.md" });

it("starts in a new worktree: create, details, tab, link, then In progress with the branch", async () => {
  const { d, calls } = deps();
  const out = await startTask(d, repo, t, "new", "claude");
  expect(calls).toEqual(["create", "details", "start", "link", "update"]);
  expect(d.worktreeCreate).toHaveBeenCalledWith("r1", "fix-it", null);
  expect(d.worktreeDetails).toHaveBeenCalledWith("/wt/fix", { item: { kind: "task", url: ".xdev/tasks/ta.md", title: "Fix it" } });
  expect(d.onStart).toHaveBeenCalledWith({ worktree: "/wt/fix", agent: "claude", prompt: startPrompt(t) });
  expect(d.boardLinkSet).toHaveBeenCalledWith("/repo", "ta", { id: "ta", worktree: "/wt/fix", tabId: "tab1", tabTitle: "claude" });
  expect(d.boardUpdate).toHaveBeenCalledWith("/repo", "ta", { status: "in-progress", branch: "fix-it" });
  expect(out).toEqual({ worktree: "/wt/fix", branch: "fix-it", tabId: "tab1" });
});

it("starts in the current worktree: no create, the tab, link, then In progress with its branch", async () => {
  const { d, calls } = deps();
  await startTask(d, repo, t, "current", null);
  expect(calls).toEqual(["start", "link", "update"]);
  expect(d.worktreeCreate).not.toHaveBeenCalled();
  expect(d.onStart).toHaveBeenCalledWith({ worktree: "/wt/main", agent: null, prompt: startPrompt(t) });
  expect(d.boardUpdate).toHaveBeenCalledWith("/repo", "ta", { status: "in-progress", branch: "main" });
});

it("a tab that is not open yet is not linked, but the task still moves", async () => {
  const { d, calls } = deps({ onStart: vi.fn(async () => null) });
  await startTask(d, repo, t, "new", "claude");
  expect(calls).toEqual(["create", "details", "update"]);
});

it("a failed create stops before any tab or write", async () => {
  const { d } = deps({ worktreeCreate: vi.fn(async () => Promise.reject({ code: "io" })) });
  await expect(startTask(d, repo, t, "new", "claude")).rejects.toEqual({ code: "io" });
  expect(d.onStart).not.toHaveBeenCalled();
  expect(d.boardUpdate).not.toHaveBeenCalled();
});

it("current without a worktree on screen rejects", async () => {
  const { d } = deps({ current: null });
  await expect(startTask(d, repo, t, "current", null)).rejects.toThrow();
});

it("a refused task link on the worktree does not stop the start", async () => {
  const { d, calls } = deps({ worktreeDetails: vi.fn(async () => Promise.reject({ code: "bad_item" })) });
  await startTask(d, repo, t, "new", "claude");
  expect(calls).toEqual(["create", "start", "link", "update"]);
});
