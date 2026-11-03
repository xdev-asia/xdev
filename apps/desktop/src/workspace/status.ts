import type { HookEvent } from "@/api";

/**
 * What a terminal tab is doing. Hooks and titles say it when the CLI reports them; timing (no
 * output is read) fills in what they do not cover.
 */
export type TabStatus = "working" | "needs-you" | "done" | "idle" | "failed" | "exited";

/** The hook events a tab's launch can report. Without one, timing stands in for it. */
export type Caps = { prompt: boolean; needsInput: boolean; turnDone: boolean };

export const NO_CAPS: Caps = { prompt: false, needsInput: false, turnDone: false };

/** What a launch reports: `claude` with hooks all three, `codex` with hooks the turn end only. */
export function capsFor(cli: "claude" | "codex" | null, hooks: boolean): Caps {
  if (!hooks || cli === null) return NO_CAPS;
  if (cli === "claude") return { prompt: true, needsInput: true, turnDone: true };
  return { prompt: false, needsInput: false, turnDone: true };
}

export interface StatusState {
  status: TabStatus;
  lastInput: number;
  lastOutput: number;
  caps: Caps;
  /** A hook event arrived on this pane; from then on titles no longer set its status. */
  hooked: boolean;
  /** When the person sent Escape or Ctrl-C to the working pane; null when no interrupt is pending. */
  interruptAt: number | null;
  /** The last turn was interrupted: a late `turn-done` for it is not a finished turn. */
  cancelled: boolean;
}

export type StatusEvent =
  | { kind: "input"; at: number; interrupt?: boolean }
  | { kind: "output"; at: number }
  | { kind: "tick"; at: number }
  | { kind: "exit"; code: number | null }
  | { kind: "hook"; event: HookEvent; at: number }
  | { kind: "title"; status: "working" | "needs-you" | "idle"; at: number }
  | { kind: "seen"; at: number };

/** Output this soon after a keystroke is the terminal echoing it, not work. */
export const ECHO_MS = 250;
/** A working tab with no output for this long is idle again. */
export const QUIET_MS = 3000;
/** After Escape or Ctrl-C on a hooked working pane, how long a hook has to say otherwise. */
export const INTERRUPT_MS = 500;

/** The keystrokes read as "stop the turn": Escape alone or Ctrl-C. */
export function isInterrupt(text: string): boolean {
  return text === "\x1b" || text === "\x03";
}

const ended = (status: TabStatus) => status === "failed" || status === "exited";
// Only a hook, a keystroke or a look moves a tab out of these.
const waiting = (status: TabStatus) => status === "needs-you" || status === "done";

export function start(caps: Caps = NO_CAPS): StatusState {
  return { status: "idle", lastInput: 0, lastOutput: 0, caps, hooked: false, interruptAt: null, cancelled: false };
}

/** One event on a tab. `seen`: the person is looking at the pane, so a finished turn is idle at once. */
export function step(s: StatusState, e: StatusEvent, seen = false): StatusState {
  const next = raw(s, e);
  return seen && next.status === "done" ? { ...next, status: "idle" } : next;
}

function raw(s: StatusState, e: StatusEvent): StatusState {
  if (ended(s.status)) return s;
  switch (e.kind) {
    case "input":
      if (e.interrupt) {
        // Only a hooked turn can be stopped this way; timing already sees the quiet after it.
        return s.status === "working" && s.caps.turnDone ? { ...s, lastInput: e.at, interruptAt: e.at } : { ...s, lastInput: e.at };
      }
      return { ...s, lastInput: e.at, cancelled: false, status: s.status === "needs-you" ? "working" : s.status };
    case "output": {
      if (e.at - s.lastInput <= ECHO_MS) return s;
      const wakes = s.status === "idle" && !s.caps.prompt;
      return { ...s, lastOutput: e.at, status: wakes ? "working" : s.status };
    }
    case "tick":
      if (s.interruptAt !== null && e.at - s.interruptAt >= INTERRUPT_MS) {
        // No hook said otherwise: the turn was stopped. Idle, not done.
        return { ...s, interruptAt: null, ...(s.status === "working" ? { status: "idle", cancelled: true } : {}) };
      }
      return s.status === "working" && !s.caps.turnDone && e.at - s.lastOutput >= QUIET_MS ? { ...s, status: "idle" } : s;
    case "exit":
      return { ...s, status: e.code === 0 ? "exited" : "failed" };
    case "hook": {
      const hooked = { ...s, hooked: true, interruptAt: null };
      if (e.event === "turn-done") {
        // The turn the person just stopped ends here: it rests and is not news.
        if (s.interruptAt !== null && e.at - s.interruptAt < INTERRUPT_MS) return { ...hooked, status: "idle", cancelled: true };
        // A late end of a stopped turn, after it already went idle.
        if (s.cancelled && s.status === "idle") return hooked;
        return { ...hooked, status: "done", cancelled: false };
      }
      return { ...hooked, cancelled: false, status: e.event === "prompt" ? "working" : "needs-you" };
    }
    case "title":
      // Fresh hook data outranks titles on a pane whose launch reports hooks.
      if (s.hooked && s.caps.turnDone) return s;
      // An idle title says nothing new about a tab that waits on the person.
      if (e.status === "idle" && waiting(s.status)) return s;
      return { ...s, status: e.status };
    case "seen":
      return s;
  }
}

/** Worktree dot order, most urgent first. */
export const URGENCY: readonly TabStatus[] = ["needs-you", "failed", "done", "working", "idle", "exited"];

/** The one status a worktree shows: the most urgent of its agent tabs, or null without any. */
export function worktreeDot(statuses: TabStatus[]): TabStatus | null {
  return URGENCY.find((s) => statuses.includes(s)) ?? null;
}
