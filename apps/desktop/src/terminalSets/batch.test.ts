import { describe, expect, it } from "vitest";
import { clampCopies, runBatch, STAGGER_MS } from "./batch";

describe("clampCopies", () => {
  it("keeps 1 to 8 and turns anything else into 1 or 8", () => {
    expect([clampCopies("3"), clampCopies(0), clampCopies(99), clampCopies("x"), clampCopies(2.9)]).toEqual([3, 1, 8, 1, 2]);
  });
});

describe("runBatch", () => {
  it("staggers spawns by 300 ms, none before the first", async () => {
    const sleeps: number[] = [];
    const out = await runBatch([0, 1, 2], () => {}, { sleep: async (ms) => void sleeps.push(ms) });
    expect(sleeps).toEqual([STAGGER_MS, STAGGER_MS]);
    expect(STAGGER_MS).toBe(300);
    expect(out).toEqual({ tried: 3, total: 3, failed: [] });
  });

  it("records a failed spawn and goes on", async () => {
    const seen: number[] = [];
    const out = await runBatch(
      [0, 1, 2],
      (i) => {
        seen.push(i);
        if (i === 1) throw new Error("boom");
      },
      { sleep: async () => {} },
    );
    expect(seen).toEqual([0, 1, 2]);
    expect(out.failed).toEqual([1]);
  });

  it("reports progress after each spawn", async () => {
    const tried: number[] = [];
    await runBatch([0, 1], () => {}, { sleep: async () => {}, onProgress: (p) => void tried.push(p.tried) });
    expect(tried).toEqual([0, 1, 2]);
  });
});
