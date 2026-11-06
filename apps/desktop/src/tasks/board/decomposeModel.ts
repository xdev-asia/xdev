import type { ApiError, TaskDraft, TaskPriority } from "@/api";

/** The three steps of the dialog. */
export type DecomposeStep = "goal" | "running" | "review";

export interface DecomposeRow {
  /** Stable while the person edits, so a row keeps its place. */
  key: number;
  checked: boolean;
  draft: TaskDraft;
}

export interface DecomposeState {
  step: DecomposeStep;
  goal: string;
  /** The id of the latest ask; an answer for another id is ignored. */
  run: number;
  error: ApiError["code"] | null;
  rows: DecomposeRow[];
}

export type DecomposeAction =
  | { type: "goal"; goal: string }
  | { type: "ask"; run: number }
  | { type: "answered"; run: number; drafts: TaskDraft[] }
  | { type: "failed"; run: number; code: ApiError["code"] }
  | { type: "cancel" }
  | { type: "back" }
  | { type: "check"; key: number; checked: boolean }
  | { type: "edit"; key: number; patch: Partial<Pick<TaskDraft, "title" | "body" | "priority">> };

export const initialDecompose: DecomposeState = { step: "goal", goal: "", run: 0, error: null, rows: [] };

/** The longest goal the command takes, in characters. */
export const MAX_GOAL = 4000;

export const canAsk = (s: DecomposeState): boolean => s.goal.trim().length > 0 && s.goal.length <= MAX_GOAL;

export function decomposeReducer(s: DecomposeState, a: DecomposeAction): DecomposeState {
  switch (a.type) {
    case "goal":
      return { ...s, goal: a.goal };
    case "ask":
      return s.step === "goal" && canAsk(s) ? { ...s, step: "running", run: a.run, error: null } : s;
    case "answered":
      if (s.step !== "running" || a.run !== s.run) return s;
      return {
        ...s,
        step: "review",
        error: null,
        rows: a.drafts.map((draft, key) => ({ key, checked: true, draft })),
      };
    case "failed":
      if (s.step !== "running" || a.run !== s.run) return s;
      return { ...s, step: "goal", error: a.code };
    // The agent keeps running; its answer finds another run id and is dropped.
    case "cancel":
      return s.step === "running" ? { ...s, step: "goal", run: s.run + 1 } : s;
    case "back":
      return s.step === "review" ? { ...s, step: "goal", rows: [], error: null } : s;
    case "check":
      return { ...s, rows: s.rows.map((r) => (r.key === a.key ? { ...r, checked: a.checked } : r)) };
    case "edit":
      return { ...s, rows: s.rows.map((r) => (r.key === a.key ? { ...r, draft: { ...r.draft, ...a.patch } } : r)) };
  }
}

/** The drafts to write: the checked rows with a title, trimmed. */
export function finalDrafts(rows: DecomposeRow[]): TaskDraft[] {
  return rows
    .filter((r) => r.checked && r.draft.title.trim() !== "")
    .map((r) => ({ ...r.draft, title: r.draft.title.trim(), status: r.draft.status ?? "todo" }));
}

export const PRIORITIES: TaskPriority[] = ["p0", "p1", "p2", "p3"];
