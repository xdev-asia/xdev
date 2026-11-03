import { describe, expect, it } from "vitest";
import type { SessionRow } from "@/api";
import { baseName, groupByDay } from "./sessionsView";

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
