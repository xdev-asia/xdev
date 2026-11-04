import { expect, it, vi } from "vitest";
import type { RepoView, SessionRow, Task, WorktreeView } from "@/api";
import { translate } from "@/i18n";
import { NO_DETAILS } from "@/workspace/worktreeDetails";
import { chatItems, RECENT_CHATS, taskItems } from "./moreItems";

const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

const wt = (path: string, name: string): WorktreeView => ({ path, name, branch: name, head: null, start: null, primary: false, pinned: false, detached: false, ...NO_DETAILS });
const repos: RepoView[] = [{ id: "x", shortName: "xdev", path: "/r/x", baseRef: "origin/main", worktreeRoot: "/wt", setupPolicy: "ask", scriptSource: "auto", localSetup: "", localArchive: "", docsDir: "docs", color: null, icon: null, ghAccount: null, localIssueCommand: "", missing: false, worktrees: [wt("/wt/oak", "oak"), wt("/wt/elm", "elm")], found: [] }];

function srow(key: string, worktree: string | null, last: number, title: string | null = key, resumable = true): SessionRow {
  return { session: { key, id: key, agent: "claude", branch: "main", title, last } as unknown as SessionRow["session"], worktree, repo: null, resumable };
}

function task(id: string, goal: string, state: Task["state"], created: number, repoPath = "/r/x"): Task {
  return { id, goal, repo: repoPath, base: "abc", branch: `task/${id}`, worktree: `/w/${id}`, state, runs: [], evidence: null, approval: null, created };
}

it("chatItems: resumable rows with a worktree, newest first, capped, untitled text", () => {
  const rows = [
    ...Array.from({ length: 25 }, (_, i) => srow(`s${i}`, "/wt/oak", 100 + i)),
    srow("nowt", null, 999),
    srow("gone", "/wt/oak", 998, "gone", false),
    srow("none", "/wt/elm", 50, null),
  ];
  rows[0] = { ...rows[0], repo: "/r/x" };
  const onResume = vi.fn();
  const items = chatItems(rows, repos, t, onResume);
  expect(items).toHaveLength(RECENT_CHATS);
  expect(items[0]).toMatchObject({ id: "chat:s24", kind: "chat", worktree: "/wt/oak", repo: "/r/x", detail: "xdev / main", activity: 124 });
  expect(items.every((i) => i.id !== "chat:nowt" && i.id !== "chat:gone")).toBe(true);
  items[0].run();
  expect(onResume).toHaveBeenCalledWith(rows[24]);
  const untitled = chatItems([srow("u", "/wt/elm", 1, null)], repos, t, onResume)[0];
  expect(untitled.title).toBe(t("palette.chat.untitled"));
  expect(untitled.keywords).toEqual(["claude", "chat", "resume"]);
});

it("taskItems maps state, leaves discarded out and sorts newest first", () => {
  const goal = "x".repeat(100);
  const tasks = [task("a", "First line\nsecond", "review", 10), task("b", goal, "running", 30), task("c", "gone", "discarded", 99), task("d", "Raw repo", "failed", 20, "/elsewhere"), task("e", "merged", "merged", 5)];
  const onOpen = vi.fn();
  const items = taskItems(tasks, repos, t, onOpen);
  expect(items.map((i) => i.id)).toEqual(["task:b", "task:d", "task:a", "task:e"]);
  expect(items[0].title).toHaveLength(80);
  expect(items[0]).toMatchObject({ status: "working", minQuery: 1, activity: 30_000, kind: "task", repo: "/r/x", detail: `xdev / task/b · ${t("tasks.state.running")}` });
  expect(items[1]).toMatchObject({ status: "failed", repo: undefined, detail: `/elsewhere / task/d · ${t("tasks.state.failed")}` });
  expect(items[2]).toMatchObject({ title: "First line", status: "needs-you" });
  expect(items[3].status).toBeNull();
  items[2].run();
  expect(onOpen).toHaveBeenCalledWith("a");
});

