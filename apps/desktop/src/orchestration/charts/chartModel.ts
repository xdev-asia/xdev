import type { Chart, ChartEdge, ChartKind, ChartProblem, ChartSeat, MissionTab, TabLink } from "@/api";
import { layoutTeam, type TeamLayout } from "../teamLayout";

export const CHART_KINDS: readonly ChartKind[] = ["hierarchy", "pipeline", "router"];
/** The same bounds as the backend (`crates/xdev-orch/src/charts.rs`). */
export const SEATS_MAX = 16;
export const NAME_MAX = 80;
export const PROMPT_MAX = 8 * 1024;
export const DEFAULT_AGENT = "claude";

/** A seat id the chart does not use yet: `seat-1`, `seat-2`, ... */
export function freeSeatId(seats: readonly Pick<ChartSeat, "id">[]): string {
  const taken = new Set(seats.map((s) => s.id));
  let n = seats.length + 1;
  while (taken.has(`seat-${n}`)) n += 1;
  return `seat-${n}`;
}

/** A chart that was never saved, with one lead seat. */
export function emptyChart(name = "", agent = DEFAULT_AGENT): Chart {
  const seats: ChartSeat[] = [{ id: "seat-1", role: "", agent, model: null, prompt: "", lead: true }];
  return { id: "", name, kind: "hierarchy", seats, edges: [], routes: [], createdMs: 0, updatedMs: 0 };
}

/** Holds the lead flag to one seat for the kinds that have a lead; a pipeline keeps the flags as they are. */
function oneLead(kind: ChartKind, seats: ChartSeat[]): ChartSeat[] {
  if (kind === "pipeline" || seats.length === 0) return seats;
  const first = Math.max(0, seats.findIndex((s) => s.lead));
  return seats.map((s, i) => (s.lead === (i === first) ? s : { ...s, lead: i === first }));
}

/**
 * The edges a chart's kind gives its seats. Hierarchy: the lead reads each worker. Pipeline: each stage reads the one
 * before it. Router: the dispatcher reads each seat it routes to. A pair that was an edge before keeps its grants.
 */
export function deriveEdges(chart: Pick<Chart, "kind" | "seats" | "routes">, before: readonly ChartEdge[] = []): ChartEdge[] {
  const pairs: [string, string][] = [];
  const lead = chart.seats.find((s) => s.lead);
  if (chart.kind === "pipeline") {
    for (let i = 1; i < chart.seats.length; i++) pairs.push([chart.seats[i].id, chart.seats[i - 1].id]);
  } else if (lead && chart.kind === "hierarchy") {
    for (const s of chart.seats) if (s.id !== lead.id) pairs.push([lead.id, s.id]);
  } else if (lead) {
    const routed = new Set(chart.routes.map((r) => r.seat));
    for (const s of chart.seats) if (s.id !== lead.id && routed.has(s.id)) pairs.push([lead.id, s.id]);
  }
  return pairs.map(([from, to]) => before.find((e) => e.from === from && e.to === to) ?? { from, to, transcript: true, screen: false });
}

/** The chart with its lead held to one seat and its edges made again from its kind. */
export function normalize(chart: Chart): Chart {
  const seats = oneLead(chart.kind, chart.seats);
  const ids = new Set(seats.map((s) => s.id));
  const routes = chart.routes.filter((r) => ids.has(r.seat));
  return { ...chart, seats, routes, edges: deriveEdges({ kind: chart.kind, seats, routes }, chart.edges) };
}

export function addSeat(chart: Chart, agent = DEFAULT_AGENT): Chart {
  if (chart.seats.length >= SEATS_MAX) return chart;
  const seat: ChartSeat = { id: freeSeatId(chart.seats), role: "", agent, model: null, prompt: "", lead: false };
  return normalize({ ...chart, seats: [...chart.seats, seat] });
}

export function removeSeat(chart: Chart, id: string): Chart {
  return normalize({ ...chart, seats: chart.seats.filter((s) => s.id !== id) });
}

/** Moves the seat at `from` to `to` (both clamped); the other seats keep their order. */
export function moveSeat(chart: Chart, from: number, to: number): Chart {
  const n = chart.seats.length;
  if (from < 0 || from >= n) return chart;
  const at = Math.min(n - 1, Math.max(0, to));
  if (at === from) return chart;
  const seats = [...chart.seats];
  const [moved] = seats.splice(from, 1);
  seats.splice(at, 0, moved);
  return normalize({ ...chart, seats });
}

export function updateSeat(chart: Chart, id: string, patch: Partial<Omit<ChartSeat, "id">>): Chart {
  return normalize({ ...chart, seats: chart.seats.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
}

/** Makes `id` the lead (hierarchy) or the dispatcher (router). */
export function setLead(chart: Chart, id: string): Chart {
  if (!chart.seats.some((s) => s.id === id)) return chart;
  return normalize({ ...chart, seats: chart.seats.map((s) => ({ ...s, lead: s.id === id })) });
}

/** Another kind; every seat, prompt and route is kept. */
export function setKind(chart: Chart, kind: ChartKind): Chart {
  return normalize({ ...chart, kind });
}

export function addRoute(chart: Chart): Chart {
  const target = chart.seats.find((s) => !s.lead) ?? chart.seats[0];
  if (!target) return chart;
  return normalize({ ...chart, routes: [...chart.routes, { kind: "", seat: target.id }] });
}

export function updateRoute(chart: Chart, index: number, patch: Partial<Chart["routes"][number]>): Chart {
  return normalize({ ...chart, routes: chart.routes.map((r, i) => (i === index ? { ...r, ...patch } : r)) });
}

export function removeRoute(chart: Chart, index: number): Chart {
  return normalize({ ...chart, routes: chart.routes.filter((_, i) => i !== index) });
}

/** What the backend would refuse, in its order (a mirror of `problems` in `charts.rs`). */
export function chartProblems(chart: Chart): ChartProblem[] {
  const out: ChartProblem[] = [];
  const name = chart.name.trim();
  if (name === "") out.push("no_name");
  else if ([...name].length > NAME_MAX) out.push("name_too_long");
  if (chart.seats.length === 0) out.push("no_seats");
  if (chart.seats.length > SEATS_MAX) out.push("too_many_seats");
  const ids = new Set<string>();
  let taken = false;
  for (const s of chart.seats) {
    if (s.id.trim() === "" || ids.has(s.id)) taken = true;
    ids.add(s.id);
  }
  if (taken) out.push("seat_id_taken");
  if (chart.seats.some((s) => s.agent.trim() === "")) out.push("no_agent");
  if (chart.seats.some((s) => new TextEncoder().encode(s.prompt).length > PROMPT_MAX)) out.push("prompt_too_long");
  const unknownEdge = chart.edges.some((e) => !ids.has(e.from) || !ids.has(e.to));
  const unknownRoute = chart.kind === "router" && chart.routes.some((r) => !ids.has(r.seat));
  if (unknownEdge || unknownRoute) out.push("unknown_seat");
  if (chart.edges.some((e) => e.from === e.to)) out.push("self_edge");
  const leads = chart.seats.filter((s) => s.lead).length;
  if (chart.kind !== "pipeline" && chart.seats.length > 0) {
    if (leads === 0) out.push("no_lead");
    else if (leads > 1) out.push("too_many_leads");
  }
  if (chart.kind === "pipeline" && !unknownEdge && hasCycle(chart)) out.push("pipeline_cycle");
  if (chart.kind === "router") {
    if (chart.routes.length === 0) out.push("no_route");
    else if (chart.routes.some((r) => r.kind.trim() === "")) out.push("blank_route");
  }
  return out;
}

function hasCycle(chart: Pick<Chart, "seats" | "edges">): boolean {
  const into = new Map(chart.seats.map((s) => [s.id, 0]));
  for (const e of chart.edges) into.set(e.to, (into.get(e.to) ?? 0) + 1);
  const ready = [...into].filter(([, n]) => n === 0).map(([id]) => id);
  let seen = 0;
  while (ready.length > 0) {
    const id = ready.pop()!;
    seen += 1;
    for (const e of chart.edges) {
      if (e.from !== id) continue;
      const n = (into.get(e.to) ?? 0) - 1;
      into.set(e.to, n);
      if (n === 0) ready.push(e.to);
    }
  }
  return seen < into.size;
}

/** The words a seat shows: its role, else its place in the list. */
export function seatLabel(seat: Pick<ChartSeat, "role">, index: number, t: (key: string, vars?: Record<string, string | number>) => string): string {
  return seat.role.trim() || t("charts.seat.unnamed", { n: index + 1 });
}

/** The preview: the seats as nodes and the edges as arrows, laid out as the team map is. */
export function previewLayout(chart: Pick<Chart, "seats" | "edges">, label: (seat: ChartSeat, index: number) => string): TeamLayout {
  return layoutTeam(
    chart.seats.map((s, i) => ({ id: s.id, label: label(s, i) })),
    chart.edges,
  );
}

/**
 * The tabs and links of the team map as a chart: each agent tab a seat (its title the role, its profile the agent), the
 * links as edges with their grants. The tab that reads the most others leads it.
 */
export function chartFromTeam(name: string, tabs: readonly Pick<MissionTab, "id" | "title" | "profile" | "agent" | "exited">[], links: readonly TabLink[]): Chart {
  const live = tabs.filter((t) => t.agent && !t.exited);
  const ids = new Map(live.map((t, i) => [t.id, `seat-${i + 1}`]));
  const reads = (id: string) => links.filter((l) => l.from === id && ids.has(l.to)).length;
  const lead = live.reduce<string | null>((best, t) => (best === null || reads(t.id) > reads(best) ? t.id : best), null);
  const seats: ChartSeat[] = live.map((t) => ({ id: ids.get(t.id)!, role: t.title?.trim() || "", agent: t.profile || DEFAULT_AGENT, model: null, prompt: "", lead: t.id === lead }));
  const edges: ChartEdge[] = links
    .filter((l) => ids.has(l.from) && ids.has(l.to))
    .map((l) => ({ from: ids.get(l.from)!, to: ids.get(l.to)!, transcript: l.transcript, screen: l.screen }));
  return { id: "", name, kind: "hierarchy", seats, edges, routes: [], createdMs: 0, updatedMs: 0 };
}

/** The problem an error from a save names, from its detail (`invalid_chart: no_lead`); null for any other error. */
export function problemOf(detail: string | undefined): ChartProblem | null {
  const m = /invalid_chart: ([a-z_]+)/.exec(detail ?? "");
  return m ? (m[1] as ChartProblem) : null;
}
