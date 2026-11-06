import type { BoardTask } from "@/api";

/** A task for a test; every field has a value and `over` changes some. */
export function task(id: string, over: Partial<BoardTask> = {}): BoardTask {
  return {
    id,
    title: `Task ${id}`,
    status: "todo",
    priority: "p2",
    assignee: null,
    labels: [],
    created: "2026-11-01T09:00:00.000Z",
    updated: "2026-11-01T09:00:00.000Z",
    branch: null,
    file: `.xdev/tasks/${id}.md`,
    bodyPreview: "",
    ...over,
  };
}
