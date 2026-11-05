import { expect, it } from "vitest";
import { dueForSleep } from "./autoSleep";
import type { Tab } from "./sessions";

const MIN = 60_000;
const NOW = 10_000_000;
const tab = (id: string, over: Partial<Tab> = {}): Tab =>
  ({ id, worktree: "/w", agent: true, status: "done", openedAt: 0, agentSession: "s-1", resumeOf: null, ...over }) as unknown as Tab;

const due = (tabs: Tab[], last: Record<string, number | null>, onScreen: string[] = [], idle = 30 * MIN) =>
  dueForSleep(tabs, (id) => last[id] ?? null, new Set(onScreen), NOW, idle);

it("picks a finished agent tab that has been quiet longer than the limit", () => {
  expect(due([tab("a")], { a: NOW - 31 * MIN })).toEqual(["a"]);
  expect(due([tab("a", { status: "idle" })], { a: NOW - 31 * MIN })).toEqual(["a"]);
});

it("leaves a tab alone that is recent, on screen, busy, asleep, ended or not an agent", () => {
  const old = NOW - 31 * MIN;
  expect(due([tab("a")], { a: NOW - 5 * MIN })).toEqual([]);
  expect(due([tab("a")], { a: old }, ["a"])).toEqual([]);
  for (const status of ["working", "needs-you", "failed", "exited"] as const) {
    expect(due([tab("a", { status })], { a: old })).toEqual([]);
  }
  expect(due([tab("a", { asleep: true })], { a: old })).toEqual([]);
  expect(due([tab("a", { agent: false })], { a: old })).toEqual([]);
});

it("counts from when the tab opened if it never wrote output", () => {
  expect(due([tab("a", { openedAt: NOW - 40 * MIN })], { a: 0 })).toEqual(["a"]);
  expect(due([tab("a", { openedAt: NOW - 10 * MIN })], { a: 0 })).toEqual([]);
});

it("an idle limit of exactly the quiet time is not yet due", () => {
  expect(due([tab("a")], { a: NOW - 30 * MIN })).toEqual([]);
  expect(due([tab("a")], { a: NOW - 30 * MIN - 1 })).toEqual(["a"]);
});

it("skips an agent tab with no known session, so it would not wake as a new conversation", () => {
  const old = NOW - 31 * MIN;
  expect(due([tab("a", { agentSession: null })], { a: old })).toEqual([]);
  expect(due([tab("a", { agentSession: null, resumeOf: "r-1" })], { a: old })).toEqual(["a"]);
});
