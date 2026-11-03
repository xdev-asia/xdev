import type { HookDetail, HookEvent } from "@/api";

/**
 * What a terminal tab is doing. Hooks and titles say it when the CLI reports them; timing (no
 * output is read) fills in what they do not cover.
 */
export type TabStatus = "working" | "needs-you" | "done" | "idle" | "failed" | "exited";

/** The hook events a tab's launch can report. Without one, timing stands in for it. */
export type Caps = { prompt: boolean; needsInput: boolean; turnDone: boolean };

export const NO_CAPS: Caps = { prompt: false, needsInput: false, turnDone: false };

/**
 * What a launch reports, from the hook events the backend says it wired: a claude past the version
 * gate or a codex on its private home has all three; an unknown claude has no needs-input; a codex on
 * `notify` alone has the turn end only.
 */
export function capsFor(events: readonly HookEvent[] | undefined): Caps {
  if (!events || events.length === 0) return NO_CAPS;
  return { prompt: events.includes("prompt"), needsInput: events.includes("needs-input"), turnDone: events.includes("turn-done") };
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
  /** The pty exited. Only an exit is final: a failed turn (`failed`) moves on with the next prompt. */
  dead: boolean;
  /** When the pane last got a hook, a keystroke or started working; a long silence is stale. */
  lastEvent: number;
}

export type StatusEvent =
  | { kind: "input"; at: number; interrupt?: boolean }
  | { kind: "output"; at: number }
  | { kind: "tick"; at: number }
  | { kind: "exit"; code: number | null }
  | { kind: "hook"; event: HookEvent; at: number; detail?: HookDetail | null }
  | { kind: "title"; status: "working" | "needs-you" | "idle"; at: number }
  | { kind: "seen"; at: number };

/** Output this soon after a keystroke is the terminal echoing it, not work. */
export const ECHO_MS = 250;
/** A working tab with no output for this long is idle again. */
export const QUIET_MS = 3000;
/** After Escape or Ctrl-C on a hooked working pane, how long a hook has to say otherwise. */
export const INTERRUPT_MS = 500;
/** A working hooked pane with no event for this long is stale: it rests as idle, unannounced. */
export const STALE_MS = 30 * 60 * 1000;

/** The keystrokes read as "stop the turn": Escape alone or Ctrl-C. */
export function isInterrupt(text: string): boolean {
  return text === "\x1b" || text === "\x03";
}

// Only a hook, a keystroke or a look moves a tab out of these.
const waiting = (status: TabStatus) => status === "needs-you" || status === "done" || status === "failed";
const stoppable = (status: TabStatus) => status === "working" || status === "needs-you";

export function start(caps: Caps = NO_CAPS): StatusState {
  return { status: "idle", lastInput: 0, lastOutput: 0, caps, hooked: false, interruptAt: null, cancelled: false, dead: false, lastEvent: 0 };
}

/** One event on a tab. `seen`: the person is looking at the pane, so a finished turn is idle at once. */
export function step(s: StatusState, e: StatusEvent, seen = false): StatusState {
  let next = raw(s, e);
  // Entering `working` starts the stale clock.
  if (next.status === "working" && s.status !== "working" && "at" in e) next = { ...next, lastEvent: e.at };
  return seen && next.status === "done" ? { ...next, status: "idle" } : next;
}

function raw(s: StatusState, e: StatusEvent): StatusState {
  if (s.dead) return s;
  switch (e.kind) {
    case "input":
      if (e.interrupt) {
        // Only a hooked turn can be stopped this way (also a permission dialog: claude sends no hook for
        // Escape there); timing already sees the quiet after it.
        return stoppable(s.status) && s.caps.turnDone ? { ...s, lastInput: e.at, interruptAt: e.at } : { ...s, lastInput: e.at };
      }
      // Typing answers a question and clears a failed turn; a hook says what comes next.
      const typed = s.status === "needs-you" ? "working" : s.status === "failed" ? "idle" : s.status;
      return { ...s, lastInput: e.at, lastEvent: e.at, cancelled: false, status: typed };
    case "output": {
      if (e.at - s.lastInput <= ECHO_MS) return s;
      const wakes = s.status === "idle" && !s.caps.prompt;
      return { ...s, lastOutput: e.at, status: wakes ? "working" : s.status };
    }
    case "tick":
      if (s.interruptAt !== null && e.at - s.interruptAt >= INTERRUPT_MS) {
        // No hook said otherwise: the turn was stopped. Idle, not done.
        return { ...s, interruptAt: null, ...(stoppable(s.status) ? { status: "idle", cancelled: true } : {}) };
      }
      // A hooked turn that went silent for good rests quietly.
      if (s.status === "working" && s.caps.turnDone && e.at - s.lastEvent >= STALE_MS) return { ...s, status: "idle" };
      return s.status === "working" && !s.caps.turnDone && e.at - s.lastOutput >= QUIET_MS ? { ...s, status: "idle" } : s;
    case "exit":
      return { ...s, dead: true, status: e.code === 0 ? "exited" : "failed" };
    case "hook": {
      const hooked = { ...s, hooked: true, interruptAt: null, lastEvent: e.at };
      switch (e.event) {
        case "interrupt":
          // codex says it: the turn was stopped, quietly. A finished or failed turn stays as it is.
          return stoppable(s.status) ? { ...hooked, status: "idle", cancelled: true } : hooked;
        case "turn-done":
          // The turn the person just stopped ends here: it rests and is not news.
          if (e.detail?.isInterrupt || (s.interruptAt !== null && e.at - s.interruptAt < INTERRUPT_MS)) {
            return { ...hooked, status: "idle", cancelled: true };
          }
          // A late end of a stopped turn, after it already went idle.
          if (s.cancelled && s.status === "idle") return hooked;
          return { ...hooked, status: "done", cancelled: false };
        case "turn-failed":
          return { ...hooked, status: "failed", cancelled: false };
        case "resume":
          // A tool ran or a question was answered: the turn goes on. A late one after a stop, or after
          // the turn ended, says nothing new.
          if (waiting(s.status) && s.status !== "needs-you") return hooked;
          if (s.cancelled && s.status === "idle") return hooked;
          return { ...hooked, cancelled: false, status: "working" };
        case "prompt":
          return { ...hooked, cancelled: false, status: "working" };
        case "needs-input":
        case "attention":
          return { ...hooked, cancelled: false, status: "needs-you" };
      }
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
