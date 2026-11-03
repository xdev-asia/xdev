import { describe, expect, it } from "vitest";
import { step, worktreeDot, type StatusState, type TabStatus } from "./status";

const idle = (): StatusState => ({ status: "idle", lastInput: 0, lastOutput: 0 });

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

  it("dot is the most urgent agent status", () => {
    expect(worktreeDot(["idle", "working"])).toBe("working");
    expect(worktreeDot(["working", "failed"])).toBe("failed");
    expect(worktreeDot(["exited", "idle"])).toBe("idle");
    expect(worktreeDot(["exited"])).toBe("exited");
    expect(worktreeDot([] as TabStatus[])).toBeNull();
  });
});
