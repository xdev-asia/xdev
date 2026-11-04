import { describe, expect, it } from "vitest";
import { createMockApi } from "@/mockApi";
import type { WorkerLifetime } from "@/api";
import { counting, countdownText, keepOpen, stripState } from "./workerLifetime";

const life = (over: Partial<WorkerLifetime> = {}): WorkerLifetime => ({ kept: false, closesAtMs: null, finished: false, ...over });

describe("countdownText", () => {
  it("formats m:ss and rounds a part second up", () => {
    expect(countdownText(102_000)).toBe("1:42");
    expect(countdownText(101_200)).toBe("1:42");
    expect(countdownText(120_000)).toBe("2:00");
    expect(countdownText(9_000)).toBe("0:09");
  });
  it("floors at 0:00", () => {
    expect(countdownText(0)).toBe("0:00");
    expect(countdownText(-5_000)).toBe("0:00");
  });
});

describe("stripState", () => {
  it("is hidden for no lifetime and for a kept worker, even a finished one", () => {
    expect(stripState(null, 0)).toEqual({ kind: "hidden" });
    expect(stripState(life({ kept: true }), 0)).toEqual({ kind: "hidden" });
    expect(stripState(life({ kept: true, finished: true, closesAtMs: 5 }), 0)).toEqual({ kind: "hidden" });
  });
  it("shows the rule while the worker runs", () => {
    expect(stripState(life(), 0)).toEqual({ kind: "running" });
  });
  it("shows the rule again when a finished worker works again (close time cleared)", () => {
    expect(stripState(life({ finished: true, closesAtMs: null }), 0)).toEqual({ kind: "running" });
  });
  it("counts down to the close time", () => {
    const l = life({ finished: true, closesAtMs: 200_000 });
    expect(stripState(l, 98_000)).toEqual({ kind: "finished", countdown: "1:42" });
    expect(stripState(l, 200_000)).toEqual({ kind: "finished", countdown: "0:00" });
    expect(stripState(l, 999_999)).toEqual({ kind: "finished", countdown: "0:00" });
  });
  it("ticks only while counting", () => {
    expect(counting({ kind: "running" })).toBe(false);
    expect(counting({ kind: "hidden" })).toBe(false);
    expect(counting({ kind: "finished", countdown: "1:00" })).toBe(true);
  });
});

describe("keepOpen", () => {
  it("hides at once, then shows what the backend stored", async () => {
    const api = createMockApi({});
    api.__orchSetLifetime("t1", life({ finished: true, closesAtMs: 1000 }));
    const seen: (WorkerLifetime | null)[] = [];
    await keepOpen(api, "t1", life({ finished: true, closesAtMs: 1000 }), (l) => seen.push(l));
    expect(seen[0]).toMatchObject({ kept: true });
    expect(seen).toHaveLength(2);
    expect(stripState(seen[0]!, 0)).toEqual({ kind: "hidden" });
    expect(seen[1]).toMatchObject({ kept: true });
  });
  it("reads the lifetime again when the call fails", async () => {
    const api = createMockApi({});
    api.orchestrationWorkerKeepOpen = async () => Promise.reject(new Error("no"));
    const real = life({ finished: true, closesAtMs: 1000 });
    api.__orchSetLifetime("t1", real);
    const seen: (WorkerLifetime | null)[] = [];
    await keepOpen(api, "t1", real, (l) => seen.push(l));
    expect(seen[0]).toMatchObject({ kept: true });
    expect(seen[1]).toEqual(real);
  });
  it("falls back to the current value when the re-read fails too", async () => {
    const api = createMockApi({});
    api.orchestrationWorkerKeepOpen = async () => Promise.reject(new Error("no"));
    api.orchestrationWorkerLifetime = async () => Promise.reject(new Error("no"));
    const real = life({ finished: true, closesAtMs: 1000 });
    const seen: (WorkerLifetime | null)[] = [];
    await keepOpen(api, "t1", real, (l) => seen.push(l));
    expect(seen[1]).toEqual(real);
  });
});
