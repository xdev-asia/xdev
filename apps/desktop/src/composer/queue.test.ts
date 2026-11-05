import { expect, it } from "vitest";
import type { Quota } from "@/api";
import { buildFacts, isIdle, parseLocal, preview, quotaFacts, quotaFor, toInput, toLocal } from "./queue";

const quota = (name: string, utilization: number | null, resetsAt: string | null): Quota =>
  ({ name, state: "ok", reason: null, asOf: null, windows: [{ key: "five_hour", utilization, resetsAt }, { key: "seven_day", utilization: 1, resetsAt: null }] }) as Quota;

it("reads the 5-hour window of each quota, with the reset as a time", () => {
  const facts = quotaFacts([quota("a", 40, "2026-11-06T10:00:00Z"), quota("b", null, null), { ...quota("c", 1, null), windows: [] }]);
  expect(facts).toEqual([
    { name: "a", resetsAt: Date.parse("2026-11-06T10:00:00Z"), utilization: 40 },
    { name: "b", resetsAt: null, utilization: null },
  ]);
});

it("takes the own quota of a tab, else the roomiest", () => {
  const facts = quotaFacts([quota("a", 80, null), quota("b", 10, null)]);
  expect(quotaFor("a", facts)?.name).toBe("a");
  expect(quotaFor(null, facts)?.name).toBe("b");
  expect(quotaFor("x", facts)?.name).toBe("b");
  expect(quotaFor(null, [])).toBeNull();
});

it("counts a working or waiting agent as busy, and a shell as idle", () => {
  expect(isIdle({ agent: true, status: "working" })).toBe(false);
  expect(isIdle({ agent: true, status: "needs-you" })).toBe(false);
  expect(isIdle({ agent: true, status: "done" })).toBe(true);
  expect(isIdle({ agent: false, status: "working" })).toBe(true);
  expect(buildFacts([{ id: "t", agent: true, status: "working" }], []).tabs).toEqual([{ id: "t", idle: false }]);
});

it("turns the form into a request, or null while it is not valid", () => {
  const draft = { kind: "in_minutes" as const, at: "", minutes: "5" };
  expect(toInput(draft, null, [])).toEqual({ kind: "in_minutes", minutes: 5 });
  expect(toInput({ ...draft, minutes: "" }, null, [])).toBeNull();
  expect(toInput({ ...draft, minutes: "1.5" }, null, [])).toBeNull();
  expect(toInput({ ...draft, minutes: "-1" }, null, [])).toBeNull();
  expect(toInput({ ...draft, kind: "at", at: "nope" }, null, [])).toBeNull();
  const at = parseLocal("2026-11-06T14:30")!;
  expect(toLocal(at)).toBe("2026-11-06T14:30");
  expect(toInput({ ...draft, kind: "at", at: "2026-11-06T14:30" }, null, [])).toEqual({ kind: "at", at });
  expect(toInput({ ...draft, kind: "after_reset" }, "a", [{ name: "a", resetsAt: 7, utilization: 1 }])).toEqual({ kind: "after_reset", quota: "a", resetAt: 7 });
  expect(toInput({ ...draft, kind: "after_reset" }, null, [])).toEqual({ kind: "after_reset", quota: null, resetAt: null });
  expect(toInput({ ...draft, kind: "idle" }, null, [])).toEqual({ kind: "idle" });
});

it("previews the first line", () => {
  expect(preview("\n  hello\nworld")).toBe("hello");
  expect(preview("x".repeat(100), 10)).toBe("xxxxxxxxx…");
});
