import type { WorktreeView } from "@/api";

// The lifecycle fields of a worktree with no details set: no title, comment,
// status, parent or work item, made by the app, not on the default branch, not renamable from its first prompt.
export const NO_DETAILS = {
  title: null,
  comment: "",
  status: null,
  parent: null,
  item: null,
  madeBy: "app",
  defaultBranch: false,
  autoName: false,
} as const satisfies Pick<
  WorktreeView,
  "title" | "comment" | "status" | "parent" | "item" | "madeBy" | "defaultBranch" | "autoName"
>;
