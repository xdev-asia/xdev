import type { BoardTask, RepoView, TaskLink, TaskPatch, TaskPriority, TaskStatus, WorkStatus, WorktreeCreated } from "@/api";
import { groupByStatus as groupWork, type ColumnId } from "@/workspace/kanbanModel";

/** The columns of the board, left to right (plan §1.4). */
export const COLUMNS: readonly TaskStatus[] = ["backlog", "todo", "in-progress", "in-review", "done"];

/** The worktree status a task status stands for (plan §1.3); backlog has none. */
export function statusToWork(s: TaskStatus): WorkStatus | null {
  return s === "backlog" ? null : s === "done" ? "completed" : s;
}

/** The task status a worktree status sets; no status is the backlog. */
export function workToStatus(w: WorkStatus | null): TaskStatus {
  return w === null ? "backlog" : w === "completed" ? "done" : w;
}

/** The id of a task file: `.xdev/tasks/t7k2m9q.md` is `t7k2m9q`. */
export function idFromFile(file: string): string {
  const name = file.split("/").pop() ?? file;
  return name.replace(/\.md$/i, "");
}

export interface Column {
  status: TaskStatus;
  tasks: BoardTask[];
}

/** Every column, in order, with its tasks in their given order; reuses the worktree board's grouping. */
export function groupByStatus(tasks: readonly BoardTask[]): Column[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const cols = groupWork(tasks.map((t) => ({ path: t.id, status: statusToWork(t.status) })));
  const at = (id: ColumnId): TaskStatus => workToStatus(id === "none" ? null : id);
  return COLUMNS.map((status) => {
    const col = cols.find((c) => at(c.id) === status);
    return { status, tasks: (col?.items ?? []).map((i) => byId.get(i.path)!) };
  });
}

/** The tasks with `id` set to `to`; the same array when it is already there or unknown. */
export function moveTask(tasks: BoardTask[], id: string, to: TaskStatus): BoardTask[] {
  const t = tasks.find((x) => x.id === id);
  if (!t || t.status === to) return tasks;
  return tasks.map((x) => (x.id === id ? { ...x, status: to } : x));
}

/** The status `step` columns from `from`, or null at either end. */
export function neighbour(from: TaskStatus, step: -1 | 1): TaskStatus | null {
  return COLUMNS[COLUMNS.indexOf(from) + step] ?? null;
}

const PRIORITY_RANK: Record<TaskPriority, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };

/** Priority first (p0 on top), then the most recently updated. */
export function byPriority(a: BoardTask, b: BoardTask): number {
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.updated.localeCompare(a.updated);
}

/** A branch and folder name for a task title: lowercase ASCII, other runs become `-`, at most 40 characters. */
export function slug(title: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  return s || "task";
}

/** The first prompt of an agent started on a task. English on purpose: the agent reads it. */
export function startPrompt(task: Pick<BoardTask, "id" | "title">): string {
  return `Work on the task in .xdev/tasks/${task.id}.md: "${task.title}". Read the file first. When you finish, set its status to in-review.`;
}

export type StartWhere = "new" | "current";

export interface StartRequest {
  worktree: string;
  agent: string | null;
  prompt: string;
}

export interface StartDeps {
  worktreeCreate(repoId: string, name: string, from: string | null, request?: { existing: string | null; sparse: string[] }): Promise<WorktreeCreated>;
  worktreeDetails(path: string, patch: { item: { kind: "task"; url: string; title: string | null } }): Promise<void>;
  boardLinkSet(repo: string, id: string, link: TaskLink | null): Promise<void>;
  boardUpdate(repo: string, id: string, patch: TaskPatch, expectedUpdated?: string): Promise<BoardTask>;
  /** Opens the agent tab; resolves with it, or null when it is not open yet (the repo waits for its setup). */
  onStart(req: StartRequest): Promise<{ tabId: string; tabTitle: string } | null>;
  /** The worktree on screen, for `current`. */
  current: { path: string; branch: string | null } | null;
}

/**
 * Starts an agent on a task: in a new worktree that carries the task as its item, or in the current
 * one. Then it links the tab to the task and moves the task to In progress. The order matters: the
 * worktree exists before its tab, and the tab before its link.
 */
export async function startTask(
  deps: StartDeps,
  repo: Pick<RepoView, "id" | "path">,
  task: BoardTask,
  where: StartWhere,
  agent: string | null,
): Promise<{ worktree: string; branch: string | null; tabId: string | null }> {
  const prompt = startPrompt(task);
  let worktree: string;
  let branch: string | null;
  if (where === "new") {
    const made = await deps.worktreeCreate(repo.id, slug(task.title), null);
    worktree = made.worktree.path;
    branch = made.worktree.branch ?? null;
    // The task link on the worktree is a convenience (the Task tag, and the status sync on its kanban card).
    // The worktree validation only accepts http(s) item URLs today, so a refusal must not stop the start.
    await deps.worktreeDetails(worktree, { item: { kind: "task", url: task.file, title: task.title } }).catch(() => {});
  } else {
    if (!deps.current) throw new Error("no current worktree");
    worktree = deps.current.path;
    branch = deps.current.branch;
  }
  const tab = await deps.onStart({ worktree, agent, prompt });
  if (tab) await deps.boardLinkSet(repo.path, task.id, { id: task.id, worktree, tabId: tab.tabId, tabTitle: tab.tabTitle });
  await deps.boardUpdate(repo.path, task.id, branch ? { status: "in-progress", branch } : { status: "in-progress" });
  return { worktree, branch, tabId: tab?.tabId ?? null };
}

/** The status a focused card moves to for a key: Alt+Left and Alt+Right step one column; null for anything else. */
export function keyMove(key: string, altKey: boolean, from: TaskStatus): TaskStatus | null {
  if (!altKey) return null;
  if (key === "ArrowLeft") return neighbour(from, -1);
  if (key === "ArrowRight") return neighbour(from, 1);
  return null;
}

/**
 * After a worktree card moved: when its item is a task, writes the task's status too (no expected
 * `updated`: the worktree is the newer word). A failure goes to `onError` and never throws, so it cannot undo the move.
 */
export function syncTaskStatus(
  api: Pick<{ boardUpdate: StartDeps["boardUpdate"] }, "boardUpdate">,
  repoPath: string | null | undefined,
  item: { kind: string; url: string } | null | undefined,
  status: WorkStatus | null,
  onError?: () => void,
): Promise<void> {
  if (item?.kind !== "task" || !repoPath) return Promise.resolve();
  return api.boardUpdate(repoPath, idFromFile(item.url), { status: workToStatus(status) }).then(
    () => undefined,
    () => onError?.(),
  );
}
