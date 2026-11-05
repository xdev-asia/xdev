import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "@/workspace/sessions";
import { waitIdle } from "./idle";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function watch(initial: Partial<Tab>) {
  const tab = { status: "idle", exitCode: undefined, ...initial } as Tab;
  let listener = () => {};
  return {
    tab,
    watch: {
      subscribe: (l: () => void) => {
        listener = l;
        return () => {};
      },
      find: () => tab as Tab | undefined,
    },
    poke: () => listener(),
  };
}

describe("waitIdle", () => {
  it("resolves true once the tab stays calm for the quiet time", async () => {
    const w = watch({});
    const p = waitIdle(w.watch, 1000, 10_000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toBe(true);
  });

  it("starts the quiet time again when the tab works", async () => {
    const w = watch({});
    const p = waitIdle(w.watch, 1000, 10_000);
    await vi.advanceTimersByTimeAsync(500);
    w.tab.status = "working";
    w.poke();
    await vi.advanceTimersByTimeAsync(1500);
    w.tab.status = "idle";
    w.poke();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toBe(true);
  });

  it("gives up at the timeout", async () => {
    const w = watch({ status: "working" });
    const p = waitIdle(w.watch, 1000, 5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toBe(false);
  });

  it("is false when the tab has exited", async () => {
    const w = watch({ exitCode: 1 });
    expect(await waitIdle(w.watch, 1000, 5000)).toBe(false);
  });
});
