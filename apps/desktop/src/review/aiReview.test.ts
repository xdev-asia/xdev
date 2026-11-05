import { expect, it, vi } from "vitest";
import { createMockApi, type Api, type ReviewAiPlan } from "@/api";
import { AiReview, readAuto, storedSeen, writeAuto, type SeenDiffs } from "./aiReview";
import { aiSeverity, findingNote, isAiNote } from "./aiFindings";

const WT = "/demo/wt/xdev-oak";
const BASE = "5555555555555555555555555555555555555555";

const hunk = (file: string, start = 1) => ({ file, newStart: start, newLines: 3, text: "@@\n" });
const plan = (n: number, hash = "h1"): ReviewAiPlan => ({ diffHash: hash, hunks: Array.from({ length: n }, (_, i) => hunk(`f${i}.ts`)), skipped: [] });
const seen = (): SeenDiffs & { keys: Set<string> } => {
  const keys = new Set<string>();
  return { keys, has: (k) => keys.has(k), add: (k) => void keys.add(k) };
};
function setup(p: ReviewAiPlan, answer: Api["worktreeReviewAiHunk"] = async (_w, h) => [{ severity: "warning", line: h.newStart + 1, text: `about ${h.file}` }]) {
  const api = createMockApi({});
  vi.spyOn(api, "worktreeReviewAiPlan").mockResolvedValue(p);
  const ask = vi.spyOn(api, "worktreeReviewAiHunk").mockImplementation(answer);
  const store = seen();
  const review = new AiReview(api, WT, store, () => 1000);
  return { api, ask, store, review };
}

it("findings become AI notes on their file and line", async () => {
  const { review } = setup(plan(2));
  await review.run(BASE);
  const s = review.snapshot();
  expect(s).toMatchObject({ phase: "done", done: 2, total: 2, error: null });
  expect(s.notes.map((n) => [n.file, n.line, n.startLine, n.body, n.sentAt, n.outdated])).toEqual([
    ["f0.ts", 2, 2, "about f0.ts", null, false],
    ["f1.ts", 2, 2, "about f1.ts", null, false],
  ]);
  expect(s.notes.every(isAiNote)).toBe(true);
  expect(s.notes.every((n) => aiSeverity(n) === "warning")).toBe(true);
  expect(new Set(s.notes.map((n) => n.id)).size).toBe(2);
});

it("a note of a person is never an AI note, and an odd id reads as info", () => {
  expect(isAiNote({ id: "nabc123" })).toBe(false);
  expect(aiSeverity({ id: "ai:zzz:1" })).toBe("info");
  const n = findingNote("a.ts", { severity: "problem", line: 4, text: "t" }, 7, 5);
  expect(n).toMatchObject({ id: "ai:problem:7", file: "a.ts", line: 4, startLine: 4, body: "t", createdAt: 5 });
  expect(aiSeverity(n)).toBe("problem");
});

it("dismiss takes one finding away and gives it back once", async () => {
  const { review } = setup(plan(2));
  await review.run(BASE);
  const [a, b] = review.snapshot().notes;
  expect(review.dismiss(a.id)).toEqual(a);
  expect(review.snapshot().notes).toEqual([b]);
  expect(review.dismiss(a.id)).toBeNull();
});

it("reports the progress of each hunk", async () => {
  const gates: (() => void)[] = [];
  const { review } = setup(plan(3), () => new Promise((resolve) => gates.push(() => resolve([]))));
  const seenStates: string[] = [];
  review.subscribe(() => seenStates.push(`${review.snapshot().phase}:${review.snapshot().done}/${review.snapshot().total}`));
  const run = review.run(BASE);
  await vi.waitFor(() => expect(gates).toHaveLength(1), { timeout: 2000 });
  expect(review.snapshot()).toMatchObject({ phase: "running", done: 0, total: 3 });
  gates[0]();
  await vi.waitFor(() => expect(gates).toHaveLength(2), { timeout: 2000 });
  expect(review.snapshot().done).toBe(1);
  gates[1]();
  await vi.waitFor(() => expect(gates).toHaveLength(3), { timeout: 2000 });
  gates[2]();
  await run;
  expect(review.snapshot()).toMatchObject({ phase: "done", done: 3 });
  expect(seenStates).toContain("running:2/3");
});

it("cancel stops before the next hunk and keeps what was found", async () => {
  const gates: (() => void)[] = [];
  const { review, ask } = setup(plan(3), (_w, h) => new Promise((resolve) => gates.push(() => resolve([{ severity: "info", line: 1, text: h.file }]))));
  const run = review.run(BASE);
  await vi.waitFor(() => expect(gates).toHaveLength(1), { timeout: 2000 });
  gates[0]();
  await vi.waitFor(() => expect(gates).toHaveLength(2), { timeout: 2000 });
  review.cancel();
  expect(review.snapshot()).toMatchObject({ phase: "cancelled", done: 1, total: 3 });
  gates[1]();
  await run;
  expect(ask).toHaveBeenCalledTimes(2);
  expect(review.snapshot().phase).toBe("cancelled");
  expect(review.snapshot().notes.map((n) => n.body)).toEqual(["f0.ts"]);
  expect(review.busy).toBe(false);
});

it("the first error stops the run and is kept once, with the findings so far", async () => {
  let calls = 0;
  const { review, ask } = setup(plan(3), async () => {
    calls++;
    if (calls === 2) throw { code: "needs_approval" };
    return [{ severity: "info", line: 1, text: "ok" }];
  });
  await review.run(BASE);
  expect(ask).toHaveBeenCalledTimes(2);
  const s = review.snapshot();
  expect(s.phase).toBe("error");
  expect(s.error).toMatchObject({ code: "needs_approval" });
  expect(s.notes).toHaveLength(1);
});

it("a plan that fails is an error", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "worktreeReviewAiPlan").mockRejectedValue({ code: "bad_ref" });
  const review = new AiReview(api, WT, seen());
  await review.run(BASE);
  expect(review.snapshot()).toMatchObject({ phase: "error", error: { code: "bad_ref" } });
});

it("lists what the plan skipped, and has nothing to ask with no hunks", async () => {
  const { review, ask } = setup({ diffHash: "x", hunks: [], skipped: [{ file: "a.png", reason: "binary" }] });
  await review.run(BASE);
  expect(ask).not.toHaveBeenCalled();
  expect(review.snapshot()).toMatchObject({ phase: "done", total: 0, skipped: [{ file: "a.png", reason: "binary" }] });
});

it("an automatic run goes once per diff hash and a new hash goes again", async () => {
  const { api, review, ask, store } = setup(plan(2, "h1"));
  await review.run(BASE, { auto: true });
  expect(ask).toHaveBeenCalledTimes(2);
  expect(store.keys.has(`${WT}|h1`)).toBe(true);
  await review.run(BASE, { auto: true });
  expect(ask).toHaveBeenCalledTimes(2);
  expect(review.snapshot().phase).toBe("idle");
  // A person's own request always runs.
  await review.run(BASE);
  expect(ask).toHaveBeenCalledTimes(4);
  vi.mocked(api.worktreeReviewAiPlan).mockResolvedValue(plan(1, "h2"));
  await review.run(BASE, { auto: true });
  expect(ask).toHaveBeenCalledTimes(5);
});

it("a stopped automatic run is not started again by itself", async () => {
  const { review, ask } = setup(plan(2), async () => {
    throw { code: "denied" };
  });
  await review.run(BASE, { auto: true });
  await review.run(BASE, { auto: true });
  expect(ask).toHaveBeenCalledTimes(1);
});

it("keeps the seen diffs in storage, the newest fifty, and the setting off by default", () => {
  const map = new Map<string, string>();
  const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
  const a = storedSeen(storage);
  expect(a.has("k0")).toBe(false);
  for (let i = 0; i < 60; i++) a.add(`k${i}`);
  expect(a.has("k0")).toBe(false);
  expect(a.has("k59")).toBe(true);
  expect(storedSeen(storage).has("k10")).toBe(true);
  map.set("xdev.review.ai.seen", "not json");
  expect(storedSeen(storage).has("k59")).toBe(false);
  expect(storedSeen(null).has("x")).toBe(false);
  expect(readAuto(storage)).toBe(false);
  writeAuto(storage, true);
  expect(readAuto(storage)).toBe(true);
  writeAuto(storage, false);
  expect(readAuto(storage)).toBe(false);
  expect(readAuto(null)).toBe(false);
});
