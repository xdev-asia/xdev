import { expect, it } from "vitest";
import type { RunRow, RunTotals } from "@/api";
import { DEFAULT_SORT, costText, durationText, nextSort, sortRows, successRate, tokensText, totalCostText, totalTokensText } from "./dashboardModel";

const priced = (usd: number) => ({ nanos: Math.round(usd * 1e9), priced: true, unpriced: false });

function row(id: string, startedAt: number | null, usd: number | null, over: Partial<RunRow> = {}): RunRow {
  return {
    runId: id, automationId: "a", automationName: "Audit", startedAt, finishedAt: null, status: "completed", durationMs: null, agent: "claude",
    usage: usd === null ? null : { tokensIn: 100, tokensOut: 50, tokensCache: 850, cost: priced(usd) }, ...over,
  };
}

const ids = (rows: RunRow[]) => rows.map((r) => r.runId);

it("sorts by start, newest first by default", () => {
  const rows = [row("a", 1, null), row("b", 3, null), row("c", 2, null)];
  expect(ids(sortRows(rows, DEFAULT_SORT))).toEqual(["b", "c", "a"]);
  expect(ids(sortRows(rows, { key: "started", dir: "asc" }))).toEqual(["a", "c", "b"]);
});

it("sorts by cost and keeps runs of unknown cost last in both directions", () => {
  const rows = [row("none", 1, null), row("low", 2, 0.1), row("high", 3, 2), row("unpriced", 4, 1, { usage: { tokensIn: 1, tokensOut: 1, tokensCache: 0, cost: { nanos: 0, priced: false, unpriced: true } } })];
  expect(ids(sortRows(rows, { key: "cost", dir: "desc" }))).toEqual(["high", "low", "none", "unpriced"]);
  expect(ids(sortRows(rows, { key: "cost", dir: "asc" }))).toEqual(["low", "high", "none", "unpriced"]);
});

it("does not change the list it sorts", () => {
  const rows = [row("a", 1, null), row("b", 2, null)];
  sortRows(rows, { key: "started", dir: "desc" });
  expect(ids(rows)).toEqual(["a", "b"]);
});

it("cycles a column: descending, ascending, back to the default", () => {
  const first = nextSort(DEFAULT_SORT, "cost");
  expect(first).toEqual({ key: "cost", dir: "desc" });
  const second = nextSort(first, "cost");
  expect(second).toEqual({ key: "cost", dir: "asc" });
  expect(nextSort(second, "cost")).toEqual(DEFAULT_SORT);
  expect(nextSort(DEFAULT_SORT, "started")).toEqual({ key: "started", dir: "asc" });
});

it("shows - for unknown usage and a figure for known", () => {
  const n = (v: number) => String(v);
  expect(tokensText(row("a", 1, null), n)).toBe("-");
  expect(costText(row("a", 1, null))).toBe("-");
  expect(tokensText(row("a", 1, 0.5), n)).toBe("1000");
  expect(costText(row("a", 1, 0.5))).toBe("$0.50");
  expect(costText(row("a", 1, 0.0042))).toBe("$0.0042");
});

const totals = (over: Partial<RunTotals>): RunTotals => ({ runs: 0, ok: 0, failed: 0, withUsage: 0, tokens: 0, cost: { nanos: 0, priced: false, unpriced: false }, ...over });

it("computes the success rate over the runs that ended", () => {
  expect(successRate(totals({}))).toBeNull();
  expect(successRate(totals({ runs: 5, ok: 2, failed: 1 }))).toBe(67);
  expect(successRate(totals({ runs: 3, ok: 0, failed: 0 }))).toBeNull();
});

it("shows - for the totals when no run has usage", () => {
  expect(totalTokensText(totals({ runs: 2 }), String)).toBe("-");
  expect(totalCostText(totals({ runs: 2 }))).toBe("-");
  expect(totalTokensText(totals({ runs: 2, withUsage: 1, tokens: 1500 }), String)).toBe("1500");
  expect(totalCostText(totals({ runs: 2, withUsage: 1, cost: priced(1.5) }))).toBe("$1.50");
});

it("writes durations", () => {
  expect(durationText(null)).toBe("-");
  expect(durationText(45_000)).toBe("45s");
  expect(durationText(125_000)).toBe("2m 05s");
  expect(durationText(3_780_000)).toBe("1h 03m");
});
