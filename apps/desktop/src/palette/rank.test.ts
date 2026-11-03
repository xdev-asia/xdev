import { expect, it } from "vitest";
import type { PaletteItem } from "./items";
import { rank, type Row } from "./rank";

const noop = () => {};
const tab = (id: string, status: PaletteItem["status"], order: number, title = id): PaletteItem => ({ id: `tab:${id}`, kind: "tab", title, status, order, worktree: "/wt/a", run: noop });
const wt = (name: string, activity: number | null = null): PaletteItem => ({ id: `wt:/wt/${name}`, kind: "worktree", title: name, activity, worktree: `/wt/${name}`, run: noop });
const set = (id: string, title: string): PaletteItem => ({ id: `set:${id}`, kind: "setting", title, run: noop });
const act = (id: string, title: string): PaletteItem => ({ id: `act:${id}`, kind: "action", title, run: noop });

const base = { query: "", filter: "all" as const, current: { worktree: null, tab: null }, recent: () => null, extra: {}, canCreate: false, now: 1_000_000_000 };
const ids = (rows: Row[]) => rows.flatMap((r) => (r.type === "item" ? [r.item.id] : []));
const labels = (rows: Row[]) => rows.flatMap((r) => (r.type === "header" ? [r.label] : []));

it("empty query: needs-you then done then failed then recent tabs, at most 6", () => {
  const items = [tab("p1", "idle", 0), tab("p2", "failed", 1), tab("p3", "done", 2), tab("p4", "needs-you", 3), tab("p5", "idle", 4), tab("p6", "working", 5), tab("p7", "idle", 6), tab("p8", "idle", 7)];
  const recent = (id: string) => (id === "tab:p7" ? 50 : id === "tab:p5" ? 10 : null);
  const rows = rank({ ...base, items, recent });
  expect(ids(rows)).toEqual(["tab:p4", "tab:p3", "tab:p2", "tab:p7", "tab:p5", "tab:p1"]);
  expect(labels(rows)).toEqual(["recentTabs"]);
});

it("empty query leaves out the shown tab unless it needs you", () => {
  const items = [tab("p1", "idle", 0), tab("p2", "needs-you", 1), tab("p3", "idle", 2)];
  expect(ids(rank({ ...base, items, current: { worktree: "/wt/a", tab: "p1" } }))).toEqual(["tab:p2", "tab:p3"]);
  expect(ids(rank({ ...base, items, current: { worktree: "/wt/a", tab: "p2" } }))).toEqual(["tab:p2", "tab:p1", "tab:p3"]);
});

it("empty query worktrees: visited first, then activity, then name; current left out", () => {
  const items = [wt("d"), wt("c", 5), wt("b", 9), wt("a"), wt("cur")];
  const recent = (id: string) => (id === "wt:/wt/d" ? 7 : null);
  const rows = rank({ ...base, items, recent, current: { worktree: "/wt/cur", tab: null } });
  expect(ids(rows)).toEqual(["wt:/wt/d", "wt:/wt/b", "wt:/wt/c", "wt:/wt/a"]);
  expect(labels(rows)).toEqual(["recentWorktrees"]);
});

it("worktree count is max(1, 10 - tabs) or 10", () => {
  const wts = Array.from({ length: 15 }, (_, i) => wt(`w${String(i).padStart(2, "0")}`));
  expect(ids(rank({ ...base, items: wts })).length).toBe(10);
  const tabs6 = Array.from({ length: 6 }, (_, i) => tab(`p${i}`, "idle", i));
  expect(ids(rank({ ...base, items: [...tabs6, ...wts] })).filter((i) => i.startsWith("wt:")).length).toBe(4);
});

it("typed query: sections in order, sorted by score then recency bucket then title", () => {
  const items = [act("a", "Open docs"), set("s", "Docs settings"), wt("docs"), wt("my-docs"), tab("t", "idle", 0, "docs")];
  const rows = rank({ ...base, items, query: "docs" });
  expect(labels(rows)).toEqual(["tabs", "worktrees", "other"]);
  expect(ids(rows)).toEqual(["tab:t", "wt:/wt/docs", "wt:/wt/my-docs", "set:s", "act:a"]);
  const recent = (id: string) => (id === "wt:/wt/b-x" ? base.now - 10 : null);
  expect(ids(rank({ ...base, items: [wt("a-x"), wt("b-x")], query: "x", recent }))).toEqual(["wt:/wt/b-x", "wt:/wt/a-x"]);
});

it("8 rows then a more row; extra adds 20", () => {
  const items = Array.from({ length: 40 }, (_, i) => wt(`w${String(i).padStart(2, "0")}`));
  const rows = rank({ ...base, items, query: "w" });
  expect(ids(rows).length).toBe(8);
  expect(rows.at(-1)).toEqual({ type: "more", section: "worktree", count: 32 });
  const more = rank({ ...base, items, query: "w", extra: { worktree: 20 } });
  expect(ids(more).length).toBe(28);
  expect(more.at(-1)).toEqual({ type: "more", section: "worktree", count: 12 });
});

it("filter keeps one kind", () => {
  const items = [tab("t", "idle", 0, "xx"), wt("xx"), set("s", "xx")];
  expect(ids(rank({ ...base, items, query: "xx", filter: "worktree" }))).toEqual(["wt:/wt/xx"]);
  expect(ids(rank({ ...base, items, query: "xx", filter: "other" }))).toEqual(["set:s"]);
});

it("empty query with a filter lists that kind", () => {
  const items = [set("s", "S"), act("a", "A"), wt("w")];
  const rows = rank({ ...base, items, filter: "other" });
  expect(ids(rows)).toEqual(["set:s", "act:a"]);
  expect(labels(rows)).toEqual(["other"]);
});

it("create row only for a valid name with a usable repo", () => {
  const items = [wt("zzz")];
  expect(rank({ ...base, items, query: "fix-it", canCreate: true }).at(-1)).toEqual({ type: "create", name: "fix-it" });
  expect(rank({ ...base, items, query: "fix-it", canCreate: false })).toEqual([]);
  expect(rank({ ...base, items, query: "two words", canCreate: true }).some((r) => r.type === "create")).toBe(false);
});

it("digits go to the first nine item rows", () => {
  const items = Array.from({ length: 12 }, (_, i) => wt(`w${String(i).padStart(2, "0")}`));
  const digits = rank({ ...base, items }).flatMap((r) => (r.type === "item" ? [r.digit] : []));
  expect(digits).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, null]);
});
