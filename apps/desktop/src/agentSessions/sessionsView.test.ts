import { describe, expect, it } from "vitest";
import type { SessionRow } from "@/api";
import { baseName, folderOf, groupByAgent, groupByDay, groupByFolder, groupRows, withinHistory, type GroupOptions } from "./sessionsView";

const NOW = new Date(2026, 10, 4, 15, 0).getTime();
const at = (daysAgo: number, hour = 9) => new Date(2026, 10, 4 - daysAgo, hour, 0).getTime();

const row = (id: string, last: number, first = last - 1000): SessionRow => ({
  session: { key: `h:${id}`, id, homeId: "own-claude", agent: "claude", cwd: "/a", branch: null, title: id, model: null, first, last, messages: 2 },
  worktree: "/a",
  repo: "/a",
  resumable: true,
});

describe("groupByDay", () => {
  it("groups by the local day of the last activity: today, yesterday, then dates", () => {
    const rows = [row("a", at(0, 14)), row("b", at(0, 8)), row("c", at(1)), row("d", at(5)), row("e", at(5, 20))];
    const groups = groupByDay(rows, "lastDesc", NOW);
    expect(groups.map((g) => [g.kind, g.rows.map((r) => r.session.id)])).toEqual([
      ["today", ["a", "b"]],
      ["yesterday", ["c"]],
      ["date", ["d", "e"]],
    ]);
    expect(new Date(groups[2].at).getDate()).toBe(new Date(at(5)).getDate());
  });

  it("with the Started sort the day is the start day", () => {
    const rows = [row("a", at(0), at(3))];
    expect(groupByDay(rows, "firstDesc", NOW)[0]).toMatchObject({ kind: "date" });
    expect(groupByDay(rows, "lastDesc", NOW)[0]).toMatchObject({ kind: "today" });
  });

  it("keeps the order of the rows and has no groups for none", () => {
    expect(groupByDay([], "lastDesc", NOW)).toEqual([]);
  });

  it("a session with no time (0) falls in the oldest date group", () => {
    const groups = groupByDay([row("a", at(0)), row("z", 0, 0)], "lastDesc", NOW);
    expect(groups.at(-1)).toMatchObject({ kind: "date" });
  });
});

describe("baseName", () => {
  it("is the last folder of a path with either separator", () => {
    expect(baseName("/demo/wt/xdev-oak/")).toBe("xdev-oak");
    expect(baseName("C:\\Code\\xdev")).toBe("xdev");
    expect(baseName("")).toBe("");
  });
});

const mk = (id: string, last: number, over: { agent?: "claude" | "codex"; worktree?: string | null; cwd?: string | null } = {}): SessionRow => ({
  session: { ...row(id, last).session, agent: over.agent ?? "claude", cwd: over.cwd === undefined ? "/a" : over.cwd },
  worktree: over.worktree === undefined ? "/a" : over.worktree,
  repo: "/a",
  resumable: true,
});
const opts = (over: Partial<GroupOptions> = {}): GroupOptions => ({ by: "day", sort: "lastDesc", now: NOW, history: null, hideEmpty: false, ...over });
const ids = (groups: ReturnType<typeof groupRows>) => groups.map((g) => [g.id.split(":")[0], g.rows.map((r) => r.session.id)]);

describe("withinHistory", () => {
  it("keeps rows by last activity within the days, counting today as day one", () => {
    const rows = [row("a", at(0)), row("b", at(6, 0)), row("c", at(7)), row("d", at(40))];
    expect(withinHistory(rows, 7, NOW).map((r) => r.session.id)).toEqual(["a", "b"]);
    expect(withinHistory(rows, 30, NOW).map((r) => r.session.id)).toEqual(["a", "b", "c"]);
    expect(withinHistory(rows, 90, NOW)).toHaveLength(4);
    expect(withinHistory(rows, null, NOW)).toBe(rows);
  });
});

describe("groupByFolder and groupByAgent", () => {
  it("folders follow the worktree, then the session folder, in order of first appearance", () => {
    const rows = [mk("a", at(0), { worktree: "/w/one" }), mk("b", at(1), { worktree: null, cwd: "/x/two" }), mk("c", at(2), { worktree: "/w/one" }), mk("d", at(3), { worktree: null, cwd: null })];
    expect(folderOf(rows[1] as SessionRow)).toBe("/x/two");
    expect(ids(groupByFolder(rows))).toEqual([["folder", ["a", "c"]], ["folder", ["b"]], ["folder", ["d"]]]);
    expect(groupByFolder(rows).map((g) => g.kind === "folder" && g.path)).toEqual(["/w/one", "/x/two", ""]);
  });

  it("agents come in a fixed order and an agent with no row is an empty group", () => {
    const groups = groupByAgent([mk("a", at(0), { agent: "codex" })]);
    expect(groups.map((g) => [g.kind === "agent" && g.agent, g.rows.length])).toEqual([["claude", 0], ["codex", 1]]);
  });
});

describe("groupRows", () => {
  const rows = [mk("a", at(0), { agent: "codex", worktree: "/w/one" }), mk("b", at(2), { worktree: "/w/two" }), mk("c", at(50), { worktree: "/w/two" })];

  it("by day it splits like groupByDay and keeps Today and Yesterday as empty groups unless hidden", () => {
    expect(ids(groupRows(rows, opts()))).toEqual([["today", ["a"]], ["yesterday", []], ["date", ["b"]], ["date", ["c"]]]);
    expect(ids(groupRows([rows[1] as SessionRow], opts()))).toEqual([["today", []], ["yesterday", []], ["date", ["b"]]]);
    expect(ids(groupRows([rows[1] as SessionRow], opts({ hideEmpty: true })))).toEqual([["date", ["b"]]]);
  });

  it("by folder, a folder whose rows are all older than the depth stays as an empty group until hidden", () => {
    const old = [...rows, mk("d", at(80), { worktree: "/w/three" })];
    expect(ids(groupRows(old, opts({ by: "folder", history: 7 })))).toEqual([["folder", ["a"]], ["folder", ["b"]], ["folder", []]]);
    expect(ids(groupRows(old, opts({ by: "folder", history: 7, hideEmpty: true })))).toEqual([["folder", ["a"]], ["folder", ["b"]]]);
  });

  it("by agent, shows both agents; hide-empty drops the one with no row in the depth", () => {
    expect(ids(groupRows(rows, opts({ by: "agent", history: 7 })))).toEqual([["agent", ["b"]], ["agent", ["a"]]]);
    expect(ids(groupRows([rows[0] as SessionRow], opts({ by: "agent" })))).toEqual([["agent", []], ["agent", ["a"]]]);
    expect(ids(groupRows([rows[0] as SessionRow], opts({ by: "agent", hideEmpty: true })))).toEqual([["agent", ["a"]]]);
  });

  it("the depth filter applies to every mode", () => {
    expect(ids(groupRows(rows, opts({ history: 7, hideEmpty: true })))).toEqual([["today", ["a"]], ["date", ["b"]]]);
  });
});
