import { describe, expect, it } from "vitest";
import type { Chart, MissionTab, TabLink } from "@/api";
import { addRoute, addSeat, chartFromTeam, chartProblems, emptyChart, moveSeat, previewLayout, problemOf, removeSeat, setKind, setLead, updateRoute, updateSeat } from "./chartModel";

function three(): Chart {
  let c = { ...emptyChart("Crew"), seats: [{ ...emptyChart().seats[0], role: "Lead" }] };
  c = addSeat(c);
  c = addSeat(c, "codex");
  c = updateSeat(c, "seat-2", { role: "Builder" });
  return updateSeat(c, "seat-3", { role: "Tester" });
}

describe("chart model", () => {
  it("adds seats under the lead of a hierarchy", () => {
    const c = three();
    expect(c.seats.map((s) => [s.id, s.agent, s.lead])).toEqual([
      ["seat-1", "claude", true],
      ["seat-2", "claude", false],
      ["seat-3", "codex", false],
    ]);
    expect(c.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["seat-1>seat-2", "seat-1>seat-3"]);
    expect(chartProblems(c)).toEqual([]);
  });

  it("reorders seats and keeps the lead", () => {
    const c = moveSeat(three(), 2, 0);
    expect(c.seats.map((s) => s.role)).toEqual(["Tester", "Lead", "Builder"]);
    expect(c.seats.find((s) => s.lead)?.role).toBe("Lead");
    expect(moveSeat(c, 0, 0)).toBe(c);
    expect(moveSeat(c, 0, 99).seats.map((s) => s.role)).toEqual(["Lead", "Builder", "Tester"]);
  });

  it("switching kind keeps every seat and makes the edges again", () => {
    const h = three();
    const p = setKind(h, "pipeline");
    expect(p.seats).toEqual(h.seats);
    expect(p.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["seat-2>seat-1", "seat-3>seat-2"]);
    const r = setKind(p, "router");
    expect(r.seats.map((s) => s.role)).toEqual(["Lead", "Builder", "Tester"]);
    expect(chartProblems(r)).toEqual(["no_route"]);
    const routed = updateRoute(addRoute(r), 0, { kind: "bug" });
    expect(routed.routes).toEqual([{ kind: "bug", seat: "seat-2" }]);
    expect(routed.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["seat-1>seat-2"]);
    expect(chartProblems(routed)).toEqual([]);
    expect(setKind(routed, "hierarchy").routes).toEqual(routed.routes);
  });

  it("holds a hierarchy to one lead, and a removed lead passes the role on", () => {
    const c = setLead(three(), "seat-3");
    expect(c.seats.filter((s) => s.lead).map((s) => s.id)).toEqual(["seat-3"]);
    const left = removeSeat(c, "seat-3");
    expect(left.seats.filter((s) => s.lead).map((s) => s.id)).toEqual(["seat-1"]);
    expect(left.edges.every((e) => e.to !== "seat-3")).toBe(true);
  });

  it("mirrors the backend's problems", () => {
    const two = { ...three(), seats: three().seats.map((s) => ({ ...s, lead: true })) };
    expect(chartProblems(two)).toEqual(["too_many_leads"]);
    const none = { ...three(), seats: three().seats.map((s) => ({ ...s, lead: false })) };
    expect(chartProblems(none)).toEqual(["no_lead"]);
    const loop = { ...setKind(three(), "pipeline") };
    loop.edges = [...loop.edges, { from: "seat-1", to: "seat-3", transcript: true, screen: false }];
    expect(chartProblems(loop)).toEqual(["pipeline_cycle"]);
    const ghost = { ...three(), edges: [{ from: "seat-1", to: "ghost", transcript: true, screen: false }] };
    expect(chartProblems(ghost)).toEqual(["unknown_seat"]);
    expect(chartProblems({ ...three(), name: " " })).toEqual(["no_name"]);
    expect(problemOf("invalid_chart: no_route")).toBe("no_route");
    expect(problemOf("not_found: x")).toBeNull();
  });

  it("lays the preview out with the team map's layout", () => {
    const layout = previewLayout(three(), (s) => s.role);
    expect(layout.nodes.map((n) => [n.label, n.layer])).toEqual([
      ["Lead", 0],
      ["Builder", 1],
      ["Tester", 1],
    ]);
    expect(layout.edges).toHaveLength(2);
  });

  it("saves the team map as a chart: agent tabs as seats, links as edges", () => {
    const tab = (id: string, title: string, agent = true): Pick<MissionTab, "id" | "title" | "profile" | "agent" | "exited"> => ({ id, title, profile: id === "b" ? "codex" : "claude", agent, exited: false });
    const links: TabLink[] = [
      { from: "a", to: "b", transcript: true, screen: false, createdMs: 0, updatedMs: 0 },
      { from: "a", to: "c", transcript: false, screen: true, createdMs: 0, updatedMs: 0 },
      { from: "a", to: "sh", transcript: true, screen: false, createdMs: 0, updatedMs: 0 },
    ];
    const c = chartFromTeam("Team", [tab("b", "Builder"), tab("a", "Lead"), tab("c", "Docs"), tab("sh", "Shell", false)], links);
    expect(c.seats.map((s) => [s.role, s.agent, s.lead])).toEqual([
      ["Builder", "codex", false],
      ["Lead", "claude", true],
      ["Docs", "claude", false],
    ]);
    expect(c.edges).toEqual([
      { from: "seat-2", to: "seat-1", transcript: true, screen: false },
      { from: "seat-2", to: "seat-3", transcript: false, screen: true },
    ]);
    expect(chartProblems(c)).toEqual([]);
  });
});
