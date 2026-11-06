import { expect, it, vi } from "vitest";
import type { TrackerItem } from "@/api";
import { startTrackerItem, trackerPrompt, trackerWorktreeName } from "./trackerStart";

const row = (patch: Partial<TrackerItem> = {}): TrackerItem => ({
  source: "linear",
  id: "1",
  key: "ENG-12",
  title: "Fix login",
  state: "Todo",
  stateKind: "todo",
  assignee: null,
  url: "https://linear.app/example/issue/ENG-12",
  updatedAt: "2026-11-06T00:00:00Z",
  ...patch,
});

it("names the worktree from key and title", () => {
  expect(trackerWorktreeName({ key: "ENG-12", title: "Sửa lỗi đăng nhập" })).toBe("eng-12-sua-loi-dang-nhap");
  expect(trackerWorktreeName({ key: "ENG-12", title: "" })).toBe("eng-12");
  expect(trackerWorktreeName({ key: "#12", title: "Fix" })).toBe("12-fix");
  const long = trackerWorktreeName({ key: "ENG-12", title: "word ".repeat(30) });
  expect(long.length).toBeLessThanOrEqual(40);
  expect(long.endsWith("-")).toBe(false);
});

it("writes the prompt with key, title and link only", () => {
  expect(trackerPrompt(row())).toBe(
    'Work on the Linear issue ENG-12: "Fix login". Link: https://linear.app/example/issue/ENG-12. Only the title is included here; ask me for details you need.',
  );
  expect(trackerPrompt(row({ source: "jira" }))).toContain("the Jira issue");
  expect(trackerPrompt(row({ source: "github" }))).toContain("the GitHub issue");
});

function deps(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const d = {
    worktreeCreate: vi.fn(async () => {
      calls.push("create");
      return { worktree: { path: "/w/eng-12", branch: "eng-12" } };
    }),
    worktreeDetails: vi.fn(async () => {
      calls.push("details");
    }),
    onStart: vi.fn(async () => {
      calls.push("start");
      return null;
    }),
    current: null as { path: string; branch: string | null } | null,
    ...over,
  };
  return { d, calls };
}

it("creates, links the issue, then starts, in that order", async () => {
  const { d, calls } = deps();
  const out = await startTrackerItem(d as never, { id: "r" }, row(), "new", "claude");
  expect(calls).toEqual(["create", "details", "start"]);
  expect(d.worktreeCreate).toHaveBeenCalledWith("r", "eng-12-fix-login", null);
  expect(d.worktreeDetails).toHaveBeenCalledWith("/w/eng-12", { item: { kind: "issue", url: row().url, title: "ENG-12 Fix login" } });
  expect(d.onStart).toHaveBeenCalledWith({ worktree: "/w/eng-12", agent: "claude", prompt: trackerPrompt(row()) });
  expect(out).toEqual({ worktree: "/w/eng-12", branch: "eng-12" });
});

it("goes on when the link is refused", async () => {
  const { d } = deps({ worktreeDetails: vi.fn(async () => Promise.reject(new Error("no"))) });
  await startTrackerItem(d as never, { id: "r" }, row(), "new", null);
  expect(d.onStart).toHaveBeenCalledTimes(1);
});

it("uses the current worktree, and throws without one", async () => {
  const { d } = deps({ current: { path: "/w/cur", branch: "cur" } });
  await startTrackerItem(d as never, { id: "r" }, row(), "current", null);
  expect(d.worktreeCreate).not.toHaveBeenCalled();
  expect(d.onStart).toHaveBeenCalledWith(expect.objectContaining({ worktree: "/w/cur" }));
  const none = deps();
  await expect(startTrackerItem(none.d as never, { id: "r" }, row(), "current", null)).rejects.toThrow();
});
