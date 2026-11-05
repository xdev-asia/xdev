import { describe, expect, it } from "vitest";
import type { SequenceStep } from "@/api";
import { plainStep, runSequence, type SequenceIo } from "./sequence";

function io(over: Partial<SequenceIo> = {}) {
  const log: string[] = [];
  const fake: SequenceIo = {
    write: async (b) => void log.push(`write:${b}`),
    sleep: async (ms) => void log.push(`sleep:${ms}`),
    idle: async () => (log.push("idle"), true),
    ...over,
  };
  return { fake, log };
}

describe("runSequence", () => {
  it("types each command with Enter, in order", async () => {
    const { fake, log } = io();
    const r = await runSequence([plainStep("a"), plainStep("b")], fake);
    expect(log).toEqual(["write:a\r", "write:b\r"]);
    expect(r).toEqual({ status: "done", ran: 2 });
  });

  it("waits N seconds or for idle between steps, and not after the last", async () => {
    const { fake, log } = io();
    const steps: SequenceStep[] = [
      { command: "a", wait: { type: "seconds", seconds: 3 } },
      { command: "b", wait: { type: "idle" } },
      { command: "c", wait: { type: "seconds", seconds: 9 } },
    ];
    await runSequence(steps, fake);
    expect(log).toEqual(["write:a\r", "sleep:3000", "write:b\r", "idle", "write:c\r"]);
  });

  it("stops at a failed write and says where", async () => {
    let n = 0;
    const log: string[] = [];
    const { fake } = io({
      write: async (b) => {
        if (++n === 2) throw new Error("gone");
        log.push(`write:${b}`);
      },
    });
    const r = await runSequence([plainStep("a"), plainStep("b"), plainStep("c")], fake);
    expect(r).toEqual({ status: "failed", ran: 1, at: 1 });
    expect(log).toEqual(["write:a\r"]);
  });

  it("stops when cancelled", async () => {
    let calls = 0;
    const { fake } = io({ cancelled: () => ++calls > 1 });
    const r = await runSequence([plainStep("a"), plainStep("b")], fake);
    expect(r.status).toBe("cancelled");
  });

  it("an empty sequence is done at once", async () => {
    expect(await runSequence([], io().fake)).toEqual({ status: "done", ran: 0 });
  });
});
