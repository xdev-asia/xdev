// Palette items for past agent chats and agent tasks.

import type { RepoView, SessionRow, Task } from "@/api";
import type { PaletteItem } from "./items";

type T = (key: string, vars?: Record<string, string | number>) => string;

/** Past chats listed in the palette. */
export const RECENT_CHATS = 20;
const GOAL_MAX = 80;

const repoOf = (repos: RepoView[], path: string | null): RepoView | undefined =>
  path === null ? undefined : repos.find((r) => r.path === path);

/** Past agent chats of every worktree: resumable, with a worktree, newest first, at most RECENT_CHATS. */
export function chatItems(rows: SessionRow[], repos: RepoView[], t: T, onResume: (row: SessionRow) => void): PaletteItem[] {
  return rows
    .filter((r) => r.resumable && r.worktree)
    .sort((a, b) => b.session.last - a.session.last)
    .slice(0, RECENT_CHATS)
    .map((row) => {
      const repo = repoOf(repos, row.repo) ?? repos.find((r) => r.worktrees.some((w) => w.path === row.worktree));
      const where = [repo?.shortName, row.session.branch].filter(Boolean).join(" / ");
      return {
        id: `chat:${row.session.key}`,
        kind: "chat" as const,
        title: row.session.title ?? t("palette.chat.untitled"),
        detail: where || undefined,
        keywords: [row.session.agent, "chat", "resume"],
        activity: row.session.last,
        worktree: row.worktree ?? undefined,
        repo: repo?.path ?? row.repo ?? undefined,
        run: () => onResume(row),
      };
    });
}

function status(state: Task["state"]): PaletteItem["status"] {
  switch (state) {
    case "review":
      return "needs-you";
    case "running":
      return "working";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

/** Agent tasks, discarded ones left out, newest first. Shown for a typed query or the Tasks filter. */
export function taskItems(tasks: Task[], repos: RepoView[], t: T, onOpen: (id: string) => void): PaletteItem[] {
  return tasks
    .filter((k) => k.state !== "discarded")
    .sort((a, b) => b.created - a.created)
    .map((task) => {
      const repo = repoOf(repos, task.repo);
      const goal = task.goal.split(/\r?\n/, 1)[0].trim();
      return {
        id: `task:${task.id}`,
        kind: "task" as const,
        title: goal.length > GOAL_MAX ? goal.slice(0, GOAL_MAX) : goal,
        detail: `${repo?.shortName ?? task.repo} / ${task.branch} · ${t(`tasks.state.${task.state}`)}`,
        keywords: ["task", task.branch],
        status: status(task.state),
        activity: task.created * 1000,
        repo: repo?.path,
        minQuery: 1,
        run: () => onOpen(task.id),
      };
    });
}
