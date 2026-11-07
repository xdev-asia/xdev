import { expect, it } from "vitest";
import type { LineAttribution } from "@/api";
import { createLineAuthorsFeed } from "./lineAuthorsFeed";

const fits: LineAttribution = { lines: 2, authors: [{ kind: "agent", tabId: "t1", agent: "claude", at: 1 }], runs: [{ from: 1, to: 1, author: 0 }] };

/** A feed with a hand-run clock and timer list, and fetches the test settles. */
function rig() {
  let clock = 0;
  const timers: Array<{ run: () => void; ms: number; cancelled: boolean }> = [];
  const fetches: Array<{ resolve: (a: LineAttribution) => void; reject: (e: unknown) => void }> = [];
  const results: Array<LineAttribution | null> = [];
  let failNow: unknown = null;
  const feed = createLineAuthorsFeed({
    fetch: () => {
      if (failNow) throw failNow;
      return new Promise<LineAttribution>((resolve, reject) => fetches.push({ resolve, reject }));
    },
    now: () => clock,
    schedule: (run, ms) => {
      const t = { run, ms, cancelled: false };
      timers.push(t);
      return t;
    },
    cancel: (t) => void (t.cancelled = true),
    onResult: (attr) => void results.push(attr),
  });
  return {
    feed,
    timers,
    fetches,
    results,
    at: (ms: number) => void (clock = ms),
    failWith: (e: unknown) => void (failNow = e),
  };
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

it("reads at once and keeps a result that fits the text, drops one that does not", async () => {
  const r = rig();
  r.feed.request("a\nb");
  expect(r.fetches).toHaveLength(1);
  r.fetches[0]!.resolve(fits);
  await settle();
  expect(r.results).toEqual([fits]);

  r.at(5000);
  r.feed.request("a\nb\nc");
  r.fetches[1]!.resolve(fits);
  await settle();
  expect(r.results).toEqual([fits, null]);
});

it("reads stay 2 s apart with one pending read at most", () => {
  const r = rig();
  r.feed.request("one");
  r.at(500);
  r.feed.request("two");
  expect(r.fetches).toHaveLength(1);
  expect(r.timers.map((t) => t.ms)).toEqual([1500]);
  r.at(800);
  r.feed.request("three");
  expect(r.timers).toHaveLength(1);
  r.at(2000);
  r.timers[0]!.run();
  expect(r.fetches).toHaveLength(2);
});

it("a change event follows the same throttle", () => {
  const r = rig();
  r.feed.request("one");
  r.at(1200);
  r.feed.changed();
  r.feed.changed();
  expect(r.fetches).toHaveLength(1);
  expect(r.timers.map((t) => t.ms)).toEqual([800]);
  r.at(2000);
  r.timers[0]!.run();
  expect(r.fetches).toHaveLength(2);
});

it("a result for a text that changed while it ran is dropped; the read for the new text wins", async () => {
  const r = rig();
  r.feed.request("old\n");
  r.at(100);
  r.feed.request("a\nb");
  r.fetches[0]!.resolve({ ...fits, lines: 2 });
  await settle();
  expect(r.results).toEqual([]);
  r.at(2100);
  r.timers[0]!.run();
  r.fetches[1]!.resolve(fits);
  await settle();
  expect(r.results).toEqual([fits]);
});

it("a failed or missing read gives null and does not throw", async () => {
  const r = rig();
  r.feed.request("a\nb");
  r.fetches[0]!.reject(new Error("worktree_unknown"));
  await settle();
  expect(r.results).toEqual([null]);

  r.failWith(new TypeError("attributionLinesHead is not a function"));
  r.at(5000);
  expect(() => r.feed.changed()).not.toThrow();
  await settle();
  expect(r.results).toEqual([null, null]);
});

it("after dispose the pending timer is cancelled and a late result is ignored", async () => {
  const r = rig();
  r.feed.request("a\nb");
  r.at(100);
  r.feed.changed();
  r.feed.dispose();
  expect(r.timers[0]!.cancelled).toBe(true);
  r.fetches[0]!.resolve(fits);
  await settle();
  expect(r.results).toEqual([]);
  r.feed.changed();
  expect(r.timers).toHaveLength(1);
});
