import type { Account, Api, ApiError, Chart, ChartMember, ChartRun, Squad, TabLink } from "./api";
import { DEFAULT_AGENT, NAME_MAX, chartProblems } from "./orchestration/charts/chartModel";

type ChartsApi = Pick<Api, "chartsList" | "chartsSave" | "chartsDelete" | "chartsDuplicate" | "chartsSaveSquad" | "chartsRunBind">;

export type MockCharts = ChartsApi & {
  /** The members every run recorded, oldest first. */
  __chartMembers(): ChartMember[];
};

function reject(detail: string): Promise<never> {
  const error: ApiError = { code: "orchestration", detail };
  return Promise.reject(error);
}

/** Charts in memory, checked as the backend checks them. `squad` reads a squad and `accounts` names their agents. */
export function createMockCharts(deps: { squad(id: string): Promise<Squad>; accounts(): Account[]; links?(links: TabLink[]): void; clock?(): number }): MockCharts {
  const clock = deps.clock ?? Date.now;
  let charts: Chart[] = [];
  const members: ChartMember[] = [];
  let seq = 0;
  const id = (prefix: string) => `${prefix}_${(++seq).toString(16).padStart(12, "0")}`;
  async function save(input: Chart): Promise<Chart> {
    const chart: Chart = structuredClone({ ...input, name: input.name.trim() });
    const problem = chartProblems(chart)[0];
    if (problem) return reject(`invalid_chart: ${problem}`);
    const now = clock();
    const old = chart.id ? charts.find((c) => c.id === chart.id) : undefined;
    const saved: Chart = { ...chart, id: chart.id || id("chart"), createdMs: old ? old.createdMs : now, updatedMs: now };
    charts = old ? charts.map((c) => (c.id === saved.id ? saved : c)) : [...charts, saved];
    return structuredClone(saved);
  }
  return {
    async chartsList() {
      return structuredClone(charts);
    },
    chartsSave: save,
    async chartsDelete(chartId) {
      const before = charts.length;
      charts = charts.filter((c) => c.id !== chartId);
      return charts.length < before;
    },
    async chartsDuplicate(chartId, name) {
      const c = charts.find((x) => x.id === chartId);
      if (!c) return reject(`not_found: no chart ${chartId}`);
      return save({ ...c, id: "", name: [...name].slice(0, NAME_MAX).join("") });
    },
    async chartsSaveSquad(squadId) {
      const squad = await deps.squad(squadId);
      const provider = (account: string | null) => deps.accounts().find((a) => a.name === account)?.provider ?? DEFAULT_AGENT;
      const seats = squad.seats
        .filter((s) => s.role === "lead" || s.account !== null)
        .map((s) => ({ id: s.role, role: s.role, agent: provider(s.account), model: null, prompt: "", lead: s.role === "lead" }));
      const edges = seats.filter((s) => !s.lead).map((s) => ({ from: "lead", to: s.id, transcript: true, screen: false }));
      return save({ id: "", name: squad.name, kind: "hierarchy", seats, edges, routes: [], createdMs: 0, updatedMs: 0 });
    },
    async chartsRunBind(chartId, tabs) {
      const chart = charts.find((c) => c.id === chartId);
      if (!chart) return reject(`not_found: no chart ${chartId}`);
      const tabOf = new Map(tabs.map((t) => [t.seat, t.tab]));
      if (new Set(tabs.map((t) => t.tab)).size !== tabs.length || chart.seats.some((s) => !tabOf.has(s.id))) return reject("bad_request: each seat needs a tab of its own");
      const runId = id("crun");
      const leadTab = chart.kind === "hierarchy" ? tabOf.get(chart.seats.find((s) => s.lead)?.id ?? "") ?? null : null;
      const made: ChartMember[] = chart.seats.map((s) => ({ tab: tabOf.get(s.id)!, runId, chartId, seat: s.id, kind: chart.kind, leadTab: s.lead ? null : leadTab }));
      members.push(...made);
      const now = clock();
      const links: TabLink[] = chart.edges.map((e) => ({ from: tabOf.get(e.from)!, to: tabOf.get(e.to)!, transcript: e.transcript, screen: e.screen, createdMs: now, updatedMs: now }));
      deps.links?.(links);
      const run: ChartRun = { runId, chartId, members: structuredClone(made), links };
      return run;
    },
    __chartMembers: () => structuredClone(members),
  };
}
