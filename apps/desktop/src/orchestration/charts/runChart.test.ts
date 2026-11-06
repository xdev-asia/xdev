import { describe, expect, it } from "vitest";
import type { Account, Api, Chart, ProfilesView, Squad } from "@/api";
import { createMockCharts } from "@/mockCharts";
import { addSeat, emptyChart, updateSeat } from "./chartModel";
import { runChart, type ChartRunHost } from "./runChart";

function profiles(off: string[] = []): Pick<Api, "profiles"> {
  const view = (id: string) => ({ profile: { id, name: id, enabled: !off.includes(id) }, installed: true, models: [] });
  return { profiles: async () => ({ profiles: [view("claude"), view("codex")] }) as unknown as ProfilesView };
}

function crew(): Chart {
  let c = updateSeat(emptyChart("Crew"), "seat-1", { role: "Lead", prompt: "Plan the work" });
  c = updateSeat(addSeat(c), "seat-2", { role: "Builder", model: "opus" });
  return updateSeat(addSeat(c, "codex"), "seat-3", { role: "Tester" });
}

function host(worktree: string | null = "/wt") {
  const opened: { worktree: string; agent: string; opts: Parameters<ChartRunHost["open"]>[2] }[] = [];
  let n = 0;
  const h: ChartRunHost = { worktree: () => worktree, open: (w, seat, opts) => void opened.push({ worktree: w, agent: seat.agent, opts }), newId: () => `tab-${++n}` };
  return { h, opened };
}

describe("runChart", () => {
  it("opens one tab per seat and records them as a run with the links", async () => {
    const charts = createMockCharts({ squad: async () => ({}) as Squad, accounts: () => [] as Account[] });
    const saved = await charts.chartsSave(crew());
    const { h, opened } = host();
    const out = await runChart({ ...profiles(), ...charts }, h, saved, (s) => s.role);
    expect(out.kind).toBe("ok");
    expect(opened.map((o) => [o.agent, o.opts.id, o.opts.title, o.opts.background])).toEqual([
      ["claude", "tab-1", "Lead", false],
      ["claude", "tab-2", "Builder", true],
      ["codex", "tab-3", "Tester", true],
    ]);
    expect(opened[0].opts.prompt).toBe("Plan the work");
    expect(opened[1].opts.prompt).toBeUndefined();
    expect(opened[1].opts.overrides).toEqual({ model: "opus", effort: null, extraArgs: [] });
    if (out.kind !== "ok") return;
    expect(out.run.links.map((l) => `${l.from}>${l.to}`)).toEqual(["tab-1>tab-2", "tab-1>tab-3"]);
    expect(charts.__chartMembers().map((m) => [m.tab, m.leadTab])).toEqual([
      ["tab-1", null],
      ["tab-2", "tab-1"],
      ["tab-3", "tab-1"],
    ]);
  });

  it("opens nothing without a worktree or with an agent that is off", async () => {
    const charts = createMockCharts({ squad: async () => ({}) as Squad, accounts: () => [] });
    const saved = await charts.chartsSave(crew());
    const none = host(null);
    expect((await runChart({ ...profiles(), ...charts }, none.h, saved, (s) => s.role)).kind).toBe("no_worktree");
    const off = host();
    expect(await runChart({ ...profiles(["codex"]), ...charts }, off.h, saved, (s) => s.role)).toEqual({ kind: "agent_unusable", agent: "codex" });
    expect(off.opened).toEqual([]);
  });

  it("waits for the worktree's setup before it opens the tabs", async () => {
    const charts = createMockCharts({ squad: async () => ({}) as Squad, accounts: () => [] });
    const saved = await charts.chartsSave(crew());
    const { h, opened } = host();
    let held: (() => void) | null = null;
    h.defer = (_w, launch) => {
      held = launch;
      return true;
    };
    const pending = runChart({ ...profiles(), ...charts }, h, saved, (s) => s.role);
    await new Promise((r) => setTimeout(r, 0));
    expect(opened).toEqual([]);
    held!();
    expect((await pending).kind).toBe("ok");
    expect(opened).toHaveLength(3);
  });
});

describe("mock charts", () => {
  it("rejects what the backend rejects, duplicates and deletes", async () => {
    const charts = createMockCharts({ squad: async () => ({}) as Squad, accounts: () => [] });
    const bad = { ...crew(), seats: crew().seats.map((s) => ({ ...s, lead: true })) };
    await expect(charts.chartsSave(bad)).rejects.toMatchObject({ detail: "invalid_chart: too_many_leads" });
    const a = await charts.chartsSave(crew());
    const b = await charts.chartsDuplicate(a.id, "Crew copy");
    expect((await charts.chartsList()).map((c) => c.name)).toEqual(["Crew", "Crew copy"]);
    expect(await charts.chartsDelete(a.id)).toBe(true);
    expect((await charts.chartsList()).map((c) => c.id)).toEqual([b.id]);
  });

  it("saves a squad as a hierarchy under its lead", async () => {
    const squad = { id: "sq", name: "Ship", repo: "/r", seats: [
      { role: "lead", account: "home" },
      { role: "implement", account: "work" },
      { role: "tests", account: null },
      { role: "review", account: "home" },
    ], test: null, created: 1 } as Squad;
    const accounts = [{ name: "home", provider: "claude" }, { name: "work", provider: "codex" }] as Account[];
    const charts = createMockCharts({ squad: async () => squad, accounts: () => accounts });
    const c = await charts.chartsSaveSquad("sq");
    expect(c.seats.map((s) => [s.id, s.agent, s.lead])).toEqual([
      ["lead", "claude", true],
      ["implement", "codex", false],
      ["review", "claude", false],
    ]);
    expect(c.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["lead>implement", "lead>review"]);
  });
});
