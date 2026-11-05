import { expect, it } from "vitest";
import type { Tab } from "@/workspace/sessions";
import { dashboardBuckets, dismissKey, dotState } from "./dashboard";

const tab = (id: string, status: string, over: Partial<Tab> = {}) => ({ id, worktree: "/a", profileId: "claude", agent: true, status, title: id, ...over }) as Tab;
const names = { "/a": { name: "oak", branch: "feat/oak" } };
const none = new Set<string>();
const src = (t: Tab, lastOutput: number | null = 1) => ({ tab: t, lastOutput });
const ids = (b: ReturnType<typeof dashboardBuckets>) => b.map((g) => [g.bucket, g.rows.map((r) => r.thread.tab.id)]);

it("maps statuses to buckets in order and drops idle and exited", () => {
  const out = dashboardBuckets(
    [src(tab("d", "done")), src(tab("w", "working")), src(tab("n", "needs-you")), src(tab("f", "failed")), src(tab("i", "idle")), src(tab("x", "exited"))],
    names,
    none,
  );
  expect(ids(out)).toEqual([["attention", ["n", "f"]], ["working", ["w"]], ["done", ["d"]]]);
});

it("drops non-agent tabs", () => {
  expect(dashboardBuckets([src(tab("s", "working", { agent: false }))], names, none)).toEqual([]);
});

it("orders newest output first and keeps input order when equal", () => {
  const out = dashboardBuckets([src(tab("a", "working"), 5), src(tab("b", "working"), 9), src(tab("c", "working"), 5), src(tab("d", "working"), null)], names, none);
  expect(ids(out)).toEqual([["working", ["b", "a", "c", "d"]]]);
});

it("a dismissed key hides the row until the status changes", () => {
  const dismissed = new Set([dismissKey("a", "done")]);
  expect(dashboardBuckets([src(tab("a", "done"))], names, dismissed)).toEqual([]);
  expect(ids(dashboardBuckets([src(tab("a", "failed"))], names, dismissed))).toEqual([["attention", ["a"]]]);
});

it("omits empty buckets and names the worktree", () => {
  const out = dashboardBuckets([src(tab("a", "done"))], names, none);
  expect(out.map((g) => g.bucket)).toEqual(["done"]);
  expect(out[0]!.rows[0]!.thread).toMatchObject({ worktreeName: "oak", branch: "feat/oak" });
  expect(out[0]!.rows[0]!.key).toBe("a:done");
});

it("maps the dot state", () => {
  expect(["needs-you", "failed", "working", "done", "idle", "exited"].map((s) => dotState(s as never))).toEqual(["waiting", "failed", "working", "done", null, null]);
});
