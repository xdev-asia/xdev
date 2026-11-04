// Sort mode of the sidebar worktree rows, stored per machine in localStorage (plan R8).
// Contract only: the sort toggle (nav-history U7) waits for the project-identity sidebar to merge.

export type SidebarSort = "manual" | "recent";
export const SIDEBAR_SORT_KEY = "xdev.sidebar.sort";
