import { expect, it, vi } from "vitest";
import { bulkSleepable, clear, click, runBulk, selectAll } from "./selection";

const order = ["a", "b", "c", "d"];
const none = { toggle: false, range: false };

it("ctrl toggles, shift selects a range, esc clears", () => {
  let s = click(clear(), "b", order, none);
  expect([...s.paths]).toEqual(["b"]);
  s = click(s, "c", order, { toggle: true, range: false });
  expect([...s.paths]).toEqual(["b", "c"]);
  s = click(click(clear(), "b", order, none), "d", order, { toggle: false, range: true });
  expect([...s.paths]).toEqual(["b", "c", "d"]);
  expect(click(s, "c", order, { toggle: true, range: false }).paths.has("c")).toBe(false);
  expect(clear().paths.size).toBe(0);
  // A path outside the order (a primary row) is never added.
  expect(click(clear(), "main", order, none).paths.size).toBe(0);
  expect([...selectAll(order).paths]).toEqual(order);
});

it("bulk runs one after another, stops the terminals first and reports failures", async () => {
  const log: string[] = [];
  const op = vi.fn(async (p: string) => {
    log.push(`op:${p}`);
    if (p === "c") throw { code: "worktree_dirty" };
    return p === "b" ? { deletedBranch: null, kept: { branch: "b" } as never } : undefined;
  });
  const before = async (p: string) => void log.push(`before:${p}`);
  const r = await runBulk(["a", "b", "c"], op, before);
  expect(log).toEqual(["before:a", "op:a", "before:b", "op:b", "before:c", "op:c"]);
  expect(r.ok).toEqual(["a", "b"]);
  expect(r.failed.map((f) => [f.path, f.error.code])).toEqual([["c", "worktree_dirty"]]);
  expect(r.kept).toHaveLength(1);
});

it("bulkSleepable is true when any picked worktree has an awake tab", () => {
  expect(bulkSleepable(new Set(["/a", "/b"]), { "/a": false, "/b": true })).toBe(true);
  expect(bulkSleepable(new Set(["/a", "/b"]), { "/a": false })).toBe(false);
  expect(bulkSleepable([], { "/a": true })).toBe(false);
});
