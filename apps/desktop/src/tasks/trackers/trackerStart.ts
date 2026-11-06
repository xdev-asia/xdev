import type { TrackerItem, WorkItem } from "@/api";
import { ISSUE_NAME_MAX } from "@/issues/issueStart";
import type { StartDeps, StartRequest, StartWhere } from "@/tasks/board/boardModel";

const PRODUCT = { github: "GitHub", linear: "Linear", jira: "Jira" } as const;

function slug(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** `eng-12-sua-loi-dang-nhap`: the key, then the title, as `[a-z0-9-]`, at most `ISSUE_NAME_MAX`. */
export function trackerWorktreeName(row: Pick<TrackerItem, "key" | "title">): string {
  const key = slug(row.key);
  const title = slug(row.title);
  const name = title === "" ? key : `${key}-${title}`;
  return (name === "" ? "issue" : name).slice(0, ISSUE_NAME_MAX).replace(/-+$/, "");
}

/** The first prompt: key, title and link only. The agent reads English. */
export function trackerPrompt(row: Pick<TrackerItem, "source" | "key" | "title" | "url">): string {
  return `Work on the ${PRODUCT[row.source]} issue ${row.key}: "${row.title}". Link: ${row.url}. Only the title is included here; ask me for details you need.`;
}

export function trackerWorkItem(row: Pick<TrackerItem, "key" | "title" | "url">): WorkItem {
  return { kind: "issue", url: row.url, title: `${row.key} ${row.title}` };
}

export type TrackerStartDeps = Pick<StartDeps, "worktreeCreate" | "worktreeDetails" | "current"> & {
  worktreeDetails(path: string, patch: { item: WorkItem }): Promise<void>;
  onStart(req: StartRequest): Promise<unknown>;
};

/** Starts an agent on a tracker row, in a new worktree that carries the issue, or in the current one. */
export async function startTrackerItem(
  deps: TrackerStartDeps,
  repo: { id: string },
  row: TrackerItem,
  where: StartWhere,
  agent: string | null,
): Promise<{ worktree: string; branch: string | null }> {
  let worktree: string;
  let branch: string | null;
  if (where === "new") {
    const made = await deps.worktreeCreate(repo.id, trackerWorktreeName(row), null);
    worktree = made.worktree.path;
    branch = made.worktree.branch ?? null;
    // The link is a convenience; a refusal must not stop the start.
    await deps.worktreeDetails(worktree, { item: trackerWorkItem(row) }).catch(() => undefined);
  } else {
    if (!deps.current) throw new Error("no current worktree");
    worktree = deps.current.path;
    branch = deps.current.branch;
  }
  await deps.onStart({ worktree, agent, prompt: trackerPrompt(row) });
  return { worktree, branch };
}
