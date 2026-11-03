/** What a terminal tab is doing, judged only from timing: no output is read. */
export type TabStatus = "working" | "idle" | "failed" | "exited";

export interface StatusState {
  status: TabStatus;
  lastInput: number;
  lastOutput: number;
}

export type StatusEvent =
  | { kind: "input"; at: number }
  | { kind: "output"; at: number }
  | { kind: "tick"; at: number }
  | { kind: "exit"; code: number | null };

/** Output this soon after a keystroke is the terminal echoing it, not work. */
export const ECHO_MS = 250;
/** A working tab with no output for this long is idle again. */
export const QUIET_MS = 3000;

const ended = (status: TabStatus) => status === "failed" || status === "exited";

export function step(s: StatusState, e: StatusEvent): StatusState {
  if (ended(s.status)) return s;
  switch (e.kind) {
    case "input":
      return { ...s, lastInput: e.at };
    case "output":
      if (e.at - s.lastInput <= ECHO_MS) return s;
      return { status: "working", lastInput: s.lastInput, lastOutput: e.at };
    case "tick":
      return s.status === "working" && e.at - s.lastOutput >= QUIET_MS ? { ...s, status: "idle" } : s;
    case "exit":
      return { ...s, status: e.code === 0 ? "exited" : "failed" };
  }
}

const URGENCY: TabStatus[] = ["failed", "working", "idle", "exited"];

/** The one status a worktree shows: the most urgent of its agent tabs, or null without any. */
export function worktreeDot(statuses: TabStatus[]): TabStatus | null {
  return URGENCY.find((s) => statuses.includes(s)) ?? null;
}
