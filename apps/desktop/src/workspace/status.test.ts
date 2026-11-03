import { describe, expect, it } from "vitest";
import { DONE_QUIET_MS, INTERRUPT_MS, NO_CAPS, QUIET_MS, STALE_MS, capsFor, isInterrupt, start, step, worktreeDot, type StatusState, type TabStatus } from "./status";

const idle = (): StatusState => start(capsFor([]));
// What the backend reports: claude past the version gate, codex on its private home, codex on notify alone.
const CLAUDE = ["prompt", "needs-input", "resume", "turn-failed", "turn-done"] as const;
const CODEX_HOME = ["prompt", "needs-input", "resume", "turn-done", "interrupt"] as const;
const NOTIFY = ["turn-done"] as const;

describe("tab status", () => {
  it("echo_after_keystroke_stays_idle", () => {
    let s = idle();
    s = step(s, { kind: "input", at: 1000 });
    s = step(s, { kind: "output", at: 1100 });
    expect(s.status).toBe("idle");
  });

  it("output_then_quiet_goes_idle", () => {
    let s = idle();
    s = step(s, { kind: "output", at: 5000 });
    expect(s.status).toBe("working");
    s = step(s, { kind: "tick", at: 7999 });
    expect(s.status).toBe("working");
    s = step(s, { kind: "tick", at: 8000 });
    expect(s.status).toBe("idle");
  });

  it("output after the echo window is work, even right after a keystroke", () => {
    let s = step(idle(), { kind: "input", at: 1000 });
    s = step(s, { kind: "output", at: 1250 });
    expect(s.status).toBe("idle");
    s = step(s, { kind: "output", at: 1251 });
    expect(s.status).toBe("working");
  });

  it("more output keeps the quiet period running from the latest output", () => {
    let s = step(idle(), { kind: "output", at: 5000 });
    s = step(s, { kind: "output", at: 7000 });
    s = step(s, { kind: "tick", at: 9999 });
    expect(s.status).toBe("working");
    s = step(s, { kind: "tick", at: 10_000 });
    expect(s.status).toBe("idle");
  });

  it("a tick does not wake an idle tab", () => {
    expect(step(idle(), { kind: "tick", at: 99_999 }).status).toBe("idle");
  });

  it("exit code picks exited or failed", () => {
    expect(step(idle(), { kind: "exit", code: 0 }).status).toBe("exited");
    expect(step(idle(), { kind: "exit", code: 1 }).status).toBe("failed");
    expect(step(idle(), { kind: "exit", code: null }).status).toBe("failed");
  });

  it("an ended tab stays ended", () => {
    let s = step(idle(), { kind: "exit", code: 1 });
    s = step(s, { kind: "output", at: 9000 });
    s = step(s, { kind: "tick", at: 20_000 });
    expect(s.status).toBe("failed");
  });

  it("hook events drive a claude tab", () => {
    let s = start(capsFor(CLAUDE));
    s = step(s, { kind: "hook", event: "prompt", at: 1 }, false);
    expect(s.status).toBe("working");
    s = step(s, { kind: "hook", event: "needs-input", at: 2 }, false);
    expect(s.status).toBe("needs-you");
    s = step(s, { kind: "input", at: 3 }, false);
    expect(s.status).toBe("working");
    s = step(s, { kind: "hook", event: "turn-done", at: 4 }, false);
    expect(s.status).toBe("done");
    s = step(s, { kind: "seen", at: 5 }, true);
    expect(s.status).toBe("idle");
  });

  it("claude with hooks does not wake on output alone", () => {
    let s = start(capsFor(CLAUDE));
    s = step(s, { kind: "output", at: 1000 });
    expect(s.status).toBe("idle");
    // Output still counts as activity.
    expect(s.lastOutput).toBe(1000);
  });

  it("caps follow the events the launch reports", () => {
    expect(capsFor(CLAUDE)).toEqual({ prompt: true, needsInput: true, turnDone: true });
    expect(capsFor(CODEX_HOME)).toEqual({ prompt: true, needsInput: true, turnDone: true });
    // An unknown claude: the two ungated events.
    expect(capsFor(["prompt", "turn-done"])).toEqual({ prompt: true, needsInput: false, turnDone: true });
    expect(capsFor(NOTIFY)).toEqual({ prompt: false, needsInput: false, turnDone: true });
    expect(capsFor(undefined)).toEqual(capsFor([]));
  });

  it("codex on its private home is driven by hooks like claude", () => {
    let s = start(capsFor(CODEX_HOME));
    s = step(s, { kind: "output", at: 1000 }, false);
    expect(s.status).toBe("idle");
    s = step(s, { kind: "hook", event: "prompt", at: 2000 }, false);
    expect(s.status).toBe("working");
    s = step(s, { kind: "hook", event: "needs-input", at: 3000 }, false);
    expect(s.status).toBe("needs-you");
    s = step(s, { kind: "hook", event: "resume", at: 4000 }, false);
    expect(s.status).toBe("working");
    s = step(s, { kind: "hook", event: "interrupt", at: 5000 }, false);
    expect(s.status).toBe("idle");
  });

  it("codex on notify alone uses timing for working and the hook for done", () => {
    let s = start(capsFor(NOTIFY));
    s = step(s, { kind: "output", at: 1000 }, false);
    expect(s.status).toBe("working");
    // Timing woke it, so quiet ends it: output alone (a redraw) does not hold it working for 30 min.
    s = step(s, { kind: "tick", at: 1000 + QUIET_MS }, false);
    expect(s.status).toBe("idle");
    s = step(s, { kind: "hook", event: "turn-done", at: 10_001 }, false);
    expect(s.status).toBe("done");
  });

  it("a pane that reports its prompt stays working through quiet", () => {
    let s = step(start(capsFor(CLAUDE)), { kind: "hook", event: "prompt", at: 1000 }, false);
    s = step(s, { kind: "tick", at: 1000 + QUIET_MS * 10 }, false);
    expect(s.status).toBe("working");
  });

  it("turn done on a seen pane is idle at once", () => {
    const s = step(start(capsFor(CLAUDE)), { kind: "hook", event: "turn-done", at: 1 }, true);
    expect(s.status).toBe("idle");
  });

  it("timing_does_not_leave_done", () => {
    for (const event of ["turn-done", "needs-input"] as const) {
      for (const caps of [capsFor(CLAUDE), capsFor(NOTIFY), capsFor([])]) {
        let s = step(start(caps), { kind: "hook", event, at: 1000 });
        const held = s.status;
        s = step(s, { kind: "output", at: 2000 });
        s = step(s, { kind: "tick", at: 6000 });
        expect(s.status).toBe(held);
        // An idle title is no news either.
        s = step(s, { kind: "title", status: "idle", at: 7000 });
        expect(s.status).toBe(held);
      }
    }
  });

  it("no hooks keeps today's timing", () => {
    let s = start(capsFor([]));
    s = step(s, { kind: "input", at: 1000 });
    s = step(s, { kind: "output", at: 1100 });
    expect(s.status).toBe("idle");
    s = step(s, { kind: "output", at: 2000 });
    expect(s.status).toBe("working");
    s = step(s, { kind: "tick", at: 5000 });
    expect(s.status).toBe("idle");
    // No reported events is no caps, whatever the CLI.
    expect(capsFor([])).toEqual(NO_CAPS);
  });

  it("a title rule sets its status", () => {
    let s = step(idle(), { kind: "title", status: "working", at: 1 });
    expect(s.status).toBe("working");
    s = step(s, { kind: "title", status: "needs-you", at: 2 });
    expect(s.status).toBe("needs-you");
    s = step(s, { kind: "input", at: 3 });
    s = step(s, { kind: "title", status: "idle", at: 4 });
    expect(s.status).toBe("idle");
  });

  it("exit 0 is exited, other codes failed", () => {
    for (const caps of [capsFor(CLAUDE), capsFor([])]) {
      const busy = step(start(caps), { kind: "hook", event: "prompt", at: 1 });
      expect(step(busy, { kind: "exit", code: 0 }).status).toBe("exited");
      expect(step(busy, { kind: "exit", code: 1 }).status).toBe("failed");
      expect(step(busy, { kind: "exit", code: null }).status).toBe("failed");
      // A hook after the end changes nothing.
      expect(step(step(busy, { kind: "exit", code: 0 }), { kind: "hook", event: "needs-input", at: 2 }).status).toBe("exited");
    }
  });

  it("urgency puts needs-you first", () => {
    expect(worktreeDot(["working", "done", "needs-you"])).toBe("needs-you");
    expect(worktreeDot(["working", "done"])).toBe("done");
    expect(worktreeDot(["done", "failed"])).toBe("failed");
  });

  it("dot is the most urgent agent status", () => {
    expect(worktreeDot(["idle", "working"])).toBe("working");
    expect(worktreeDot(["working", "failed"])).toBe("failed");
    expect(worktreeDot(["exited", "idle"])).toBe("idle");
    expect(worktreeDot(["exited"])).toBe("exited");
    expect(worktreeDot([] as TabStatus[])).toBeNull();
  });
  it("hook data outranks titles on a hooked pane", () => {
    // Before any hook, a title still counts.
    let s = step(start(capsFor(CLAUDE)), { kind: "title", status: "working", at: 1 });
    expect(s.status).toBe("working");
    s = step(s, { kind: "hook", event: "needs-input", at: 2 });
    expect(s.hooked).toBe(true);
    s = step(s, { kind: "title", status: "working", at: 3 });
    expect(s.status).toBe("needs-you");
    // Without hooks, titles keep setting it.
    let plain = step(idle(), { kind: "title", status: "needs-you", at: 1 });
    plain = step(plain, { kind: "title", status: "working", at: 2 });
    expect(plain.status).toBe("working");
  });

  it("an interrupt with no hook after it settles idle, not done", () => {
    let s = step(start(capsFor(CLAUDE)), { kind: "hook", event: "prompt", at: 1000 });
    s = step(s, { kind: "input", at: 2000, interrupt: true });
    expect(s).toMatchObject({ status: "working", interruptAt: 2000 });
    s = step(s, { kind: "tick", at: 2000 + INTERRUPT_MS - 1 });
    expect(s.status).toBe("working");
    s = step(s, { kind: "tick", at: 2000 + INTERRUPT_MS });
    expect(s).toMatchObject({ status: "idle", interruptAt: null, cancelled: true });
    // A late end of the stopped turn is not a finished turn.
    s = step(s, { kind: "hook", event: "turn-done", at: 4000 });
    expect(s.status).toBe("idle");
    // The next prompt is a new turn that can finish.
    s = step(s, { kind: "hook", event: "prompt", at: 5000 });
    s = step(s, { kind: "hook", event: "turn-done", at: 6000 });
    expect(s.status).toBe("done");
  });

  it("a turn end right after an interrupt rests; other hooks keep the turn", () => {
    const working = step(start(capsFor(CLAUDE)), { kind: "hook", event: "prompt", at: 1000 });
    const stopped = step(working, { kind: "input", at: 2000, interrupt: true });
    expect(step(stopped, { kind: "hook", event: "turn-done", at: 2100 }).status).toBe("idle");
    const asked = step(stopped, { kind: "hook", event: "needs-input", at: 2100 });
    expect(asked).toMatchObject({ status: "needs-you", interruptAt: null });
    const kept = step(stopped, { kind: "hook", event: "prompt", at: 2100 });
    expect(step(kept, { kind: "tick", at: 3000 }).status).toBe("working");
  });

  it("an interrupt only counts on a hooked working pane", () => {
    expect(isInterrupt("\x1b")).toBe(true);
    expect(isInterrupt("\x03")).toBe(true);
    // Arrow keys start with Escape but are not one.
    expect(isInterrupt("\x1b[A")).toBe(false);
    let plain = step(idle(), { kind: "output", at: 1000 });
    plain = step(plain, { kind: "input", at: 2000, interrupt: true });
    expect(plain.interruptAt).toBeNull();
    const rest = step(start(capsFor(CLAUDE)), { kind: "input", at: 1, interrupt: true });
    expect(rest.interruptAt).toBeNull();
  });

  it("escape in needs-you settles idle after 500 ms of silence", () => {
    let s = step(start(capsFor(CLAUDE)), { kind: "hook", event: "needs-input", at: 1000 });
    s = step(s, { kind: "input", at: 2000, interrupt: true });
    expect(s).toMatchObject({ status: "needs-you", interruptAt: 2000 });
    expect(step(s, { kind: "tick", at: 2000 + INTERRUPT_MS - 1 }).status).toBe("needs-you");
    expect(step(s, { kind: "tick", at: 2000 + INTERRUPT_MS })).toMatchObject({ status: "idle", cancelled: true });
    // A hook inside the window wins: the dialog went on.
    expect(step(s, { kind: "hook", event: "resume", at: 2100 })).toMatchObject({ status: "working", interruptAt: null });
  });

  it("an interrupt hook settles working and needs-you at once; done stays", () => {
    const caps = capsFor(NOTIFY);
    const working = step(start(caps), { kind: "hook", event: "prompt", at: 1 });
    expect(step(working, { kind: "hook", event: "interrupt", at: 2 })).toMatchObject({ status: "idle", cancelled: true });
    const asking = step(start(caps), { kind: "hook", event: "needs-input", at: 1 });
    expect(step(asking, { kind: "hook", event: "interrupt", at: 2 }).status).toBe("idle");
    const done = step(working, { kind: "hook", event: "turn-done", at: 2 });
    expect(step(done, { kind: "hook", event: "interrupt", at: 3 }).status).toBe("done");
  });

  it("a turn-done with the interrupt flag is not done", () => {
    const working = step(start(capsFor(CLAUDE)), { kind: "hook", event: "prompt", at: 1 });
    const detail = { toolName: null, message: null, isInterrupt: true, error: null };
    expect(step(working, { kind: "hook", event: "turn-done", at: 2, detail })).toMatchObject({ status: "idle", cancelled: true });
  });

  it("resume goes back to working; attention asks like needs-input", () => {
    const caps = capsFor(CLAUDE);
    let s = step(start(caps), { kind: "hook", event: "needs-input", at: 1 });
    s = step(s, { kind: "hook", event: "resume", at: 2 });
    expect(s.status).toBe("working");
    s = step(s, { kind: "hook", event: "attention", at: 3 });
    expect(s.status).toBe("needs-you");
    // A resume while a done still settles means the turn went on (R18); once settled, it changes nothing.
    const done = step(s, { kind: "hook", event: "turn-done", at: 4 });
    expect(step(done, { kind: "hook", event: "resume", at: 5 }).status).toBe("working");
    expect(step(done, { kind: "hook", event: "resume", at: 4 + DONE_QUIET_MS }).status).toBe("done");
    const stopped = step(step(s, { kind: "hook", event: "interrupt", at: 4 }), { kind: "hook", event: "resume", at: 5 });
    expect(stopped.status).toBe("idle");
  });

  it("a failed turn is not the end of the pane", () => {
    const caps = capsFor(CLAUDE);
    let s = step(start(caps), { kind: "hook", event: "prompt", at: 1 });
    s = step(s, { kind: "hook", event: "turn-failed", at: 2 });
    expect(s).toMatchObject({ status: "failed", dead: false });
    expect(step(s, { kind: "hook", event: "prompt", at: 3 }).status).toBe("working");
    expect(step(s, { kind: "input", at: 3 }).status).toBe("idle");
    // An exit is final.
    const gone = step(s, { kind: "exit", code: 1 });
    expect(gone).toMatchObject({ status: "failed", dead: true });
    expect(step(gone, { kind: "hook", event: "prompt", at: 4 }).status).toBe("failed");
  });

  it("working with no event for 30 minutes goes idle, unannounced", () => {
    let s = step(start(capsFor(CLAUDE)), { kind: "hook", event: "prompt", at: 1000 });
    expect(step(s, { kind: "tick", at: 1000 + STALE_MS - 1 }).status).toBe("working");
    expect(step(s, { kind: "tick", at: 1000 + STALE_MS })).toMatchObject({ status: "idle", cancelled: false });
    // Any hook restarts the clock.
    s = step(s, { kind: "hook", event: "resume", at: 5000 });
    expect(step(s, { kind: "tick", at: 1000 + STALE_MS }).status).toBe("working");
    expect(step(s, { kind: "tick", at: 5000 + STALE_MS }).status).toBe("idle");
  });
});
