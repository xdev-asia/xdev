import type { ApiError, WorkStatus, WorktreeChange, WorktreeView } from "@/api";
import type { ScriptKind } from "@/api";
import type { AgentChoice } from "./CreateWorktreeDialog";
import type { BulkResult } from "./selection";
import type { PendingLists } from "./setupFlow";
import type { Sessions } from "./sessions";

/** How often the auto sleep check runs. */
export const AUTO_SLEEP_TICK_MS = 60_000;

export const SELECTED_KEY = "xdev.workspace.selected";

// Storage can be missing or refuse access; the selection is only a convenience.
export function readSelected(): string | null {
  try {
    return localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
}

export function storeSelected(path: string): void {
  try {
    localStorage.setItem(SELECTED_KEY, path);
  } catch {
    // Not remembered; the next launch starts at the first worktree.
  }
}

export type View = "workspace" | "docs" | "settings" | "automations";
export type PanelTab = "files" | "search" | "changes" | "checks" | "pr" | "issues" | "ports";
export type Creating = { repoId: string; name?: string; status?: WorkStatus | null; agents: AgentChoice[]; defaultAgent: string | null };
export type Editing = { worktree: WorktreeView; busy: boolean; error?: ApiError["code"] };
export type SetupCardAt = { kind: "detected"; command: string; repoId: string } | { kind: "ask"; repoId: string };
export type TrustAsk = { path: string; repoId: string; kind: ScriptKind | "lists"; text: string; hash: string; lists: PendingLists; changed: boolean; busy: boolean; error?: ApiError["code"] };
export type BulkState = { mode: "delete" | "archive"; worktrees: WorktreeView[]; dirty: Record<string, boolean>; busy: boolean; result?: BulkResult };
export type Review = { repoId: string | null; busy: boolean; error?: ApiError["code"] };
export type Removing = { worktree: WorktreeView; dirty: boolean; busy: boolean; error?: ApiError["code"]; archiving?: boolean; failed?: { code: number | null; output: string };
  /** Removed without asking (Settings → General): the dialog stays hidden until something needs an answer. */
  quiet?: boolean;
  /** Opened from "Delete with nested worktrees": the nested tick starts on. */
  nested?: boolean;
};

// One array for every render, so an unlisted worktree does not look like a new list each time.
export const NO_CHANGES: WorktreeChange[] = [];

export function working(sessions: Sessions, path: string): number {
  return sessions.tabs(path).filter((tab) => tab.agent && tab.status === "working").length;
}

/** Agent tabs of a worktree that wait on the person. */
export function waitingIn(sessions: Sessions, path: string): number {
  return sessions.tabs(path).filter((tab) => tab.agent && tab.status === "needs-you").length;
}

/** The listed name of a worktree; the folder name when the list does not have it. */
export function worktreeName(list: WorktreeView[], path: string): string {
  return list.find((w) => w.path === path)?.name ?? path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function windowFocused(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState !== "hidden" && (typeof document.hasFocus !== "function" || document.hasFocus());
}
