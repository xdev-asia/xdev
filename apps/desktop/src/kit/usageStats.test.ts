import { describe, expect, it } from "vitest";
import { bestDay, cacheReuse, formatCost, recentDays } from "./usageStats";

const tk = (input: number, cache_read = 0, output = 0, cache_write = 0) => ({ input, output, cache_read, cache_write });

describe("cacheReuse", () => {
  it("is null without input-side tokens", () => {
    expect(cacheReuse(tk(0, 0, 50))).toBeNull();
  });
  it("is the cache share of input and cache reads", () => {
    const r = cacheReuse(tk(1, 2));
    expect(r).toBeCloseTo(0.6667, 3);
    expect(Math.round((r ?? 0) * 100)).toBe(67);
    expect(cacheReuse(tk(0, 5))).toBe(1);
    expect(cacheReuse(tk(4, 0))).toBe(0);
  });
});

describe("formatCost", () => {
  it("is n/a when nothing is priced, whatever the sum", () => {
    expect(formatCost({ nanos: 5_000_000_000, unpriced: true, priced: false })).toBe("n/a");
  });
  it("shows four decimals under a cent and two from a cent", () => {
    expect(formatCost({ nanos: 4_200_000, unpriced: false, priced: true })).toBe("$0.0042");
    expect(formatCost({ nanos: 0, unpriced: false, priced: true })).toBe("$0.0000");
    expect(formatCost({ nanos: 10_000_000, unpriced: false, priced: true })).toBe("$0.01");
    expect(formatCost({ nanos: 12_344_000_000, unpriced: true, priced: true })).toBe("$12.34");
  });
});

describe("recentDays", () => {
  const now = new Date(2026, 10, 4, 15, 30);
  it("lists the days ending today, oldest first", () => {
    const r = recentDays([], 42, now);
    expect(r).toHaveLength(42);
    expect(r[0]!.day).toBe("2026-09-24");
    expect(r[41]!.day).toBe("2026-11-04");
    expect(r.every((d) => d.level === 0 && d.total === 0)).toBe(true);
  });
  it("crosses a month and a year edge", () => {
    const r = recentDays([], 5, new Date(2026, 0, 2));
    expect(r.map((d) => d.day)).toEqual(["2025-12-29", "2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02"]);
    expect(recentDays([], 3, new Date(2024, 2, 1)).map((d) => d.day)).toEqual(["2024-02-28", "2024-02-29", "2024-03-01"]);
  });
  it("puts a missing day at level 0 and the busiest at 4", () => {
    const r = recentDays([["2026-11-04", tk(100)], ["2026-11-02", tk(10)]], 3, now);
    expect(r.map((d) => [d.day, d.total, d.level])).toEqual([
      ["2026-11-02", 10, 1],
      ["2026-11-03", 0, 0],
      ["2026-11-04", 100, 4],
    ]);
  });
  it("cuts the levels at 25, 50 and 75 percent, each included in the lower level", () => {
    const days: [string, ReturnType<typeof tk>][] = [
      ["2026-11-01", tk(25)],
      ["2026-11-02", tk(26)],
      ["2026-11-03", tk(50)],
      ["2026-11-04", tk(100)],
    ];
    const r = recentDays([...days, ["2026-10-31", tk(75)], ["2026-10-30", tk(76)]], 6, now);
    // 76 % is 4, 75 % is 3, 25 % is 1, 26 % is 2, 50 % is 2, 100 % is 4.
    expect(r.map((d) => d.level)).toEqual([4, 3, 1, 2, 2, 4]);
  });
  it("ignores days outside the window", () => {
    const r = recentDays([["2026-01-01", tk(999)], ["2026-11-04", tk(1)]], 2, now);
    expect(r.map((d) => d.level)).toEqual([0, 4]);
  });
});

describe("bestDay", () => {
  it("is null with no tokens", () => {
    expect(bestDay([])).toBeNull();
    expect(bestDay([["2026-11-01", tk(0)]])).toBeNull();
  });
  it("is the largest total, the earlier day on a tie", () => {
    expect(bestDay([["2026-11-01", tk(5)], ["2026-11-02", tk(9)], ["2026-11-03", tk(2, 3, 4)]])).toBe("2026-11-02");
    expect(bestDay([["2026-11-03", tk(9)], ["2026-11-02", tk(9)]])).toBe("2026-11-02");
    expect(bestDay([["2026-11-02", tk(9)], ["2026-11-03", tk(9)]])).toBe("2026-11-02");
  });
});
