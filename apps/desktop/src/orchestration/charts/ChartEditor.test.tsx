import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Chart } from "@/api";
import { translate } from "@/i18n";
import { mount, nodes, textOf, type Node } from "@/kit/testHooks";
import { ChartEditor, type ChartEditorProps } from "./ChartEditor";
import { ChartPreview } from "./ChartPreview";
import { addSeat, emptyChart, updateSeat } from "./chartModel";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const Editor = ChartEditor as unknown as (p: ChartEditorProps) => ReactElement;
const Preview = ChartPreview as unknown as (p: { chart: Chart }) => ReactElement;
const AGENTS = [
  { id: "claude", name: "Claude", models: ["opus", "sonnet"] },
  { id: "codex", name: "Codex", models: [] },
];

function setup(start: Chart) {
  let chart = start;
  const m = mount(Editor, () => ({ chart, agents: AGENTS, onChange: (c: Chart) => void (chart = c) }));
  return { m, get: () => chart };
}

const byLabel = (all: Node[], label: string) => all.find((n) => n.props["aria-label"] === label || n.props.label === label);
const seats = (all: Node[]) => all.filter((n) => n.type === "li" && n.props.className === "charts-seat");
const buttonText = (all: Node[], text: string) => all.find((n) => typeof n.props.onClick === "function" && textOf(n) === text);

function crew(): Chart {
  let c = updateSeat(emptyChart("Crew"), "seat-1", { role: "Lead" });
  c = updateSeat(addSeat(c), "seat-2", { role: "Builder" });
  return updateSeat(addSeat(c), "seat-3", { role: "Tester" });
}

describe("ChartEditor", () => {
  it("adds a seat and announces it", async () => {
    const { m, get } = setup(emptyChart("Crew"));
    let all = await m.settle();
    expect(seats(all)).toHaveLength(1);
    buttonText(all, en("charts.seat.add"))!.props.onClick();
    all = m.all();
    expect(get().seats).toHaveLength(2);
    expect(seats(all)).toHaveLength(2);
    expect(textOf(all.find((n) => n.props.role === "status")!)).toBe(en("charts.seat.added", { n: 2 }));
  });

  it("reorders seats with the keyboard buttons and by drag and drop", async () => {
    const { m, get } = setup(crew());
    let all = await m.settle();
    expect(byLabel(all, en("charts.seat.up", { name: "Lead" }))!.props.disabled).toBe(true);
    byLabel(all, en("charts.seat.down", { name: "Lead" }))!.props.onClick();
    expect(get().seats.map((s) => s.role)).toEqual(["Builder", "Lead", "Tester"]);
    all = m.all();
    expect(textOf(all.find((n) => n.props.role === "status")!)).toBe(en("charts.seat.moved", { name: "Lead", n: 2 }));
    // Drag Tester onto the first row.
    const data = { effectAllowed: "", setData() {} };
    seats(all)[2].props.onDragStart({ dataTransfer: data });
    all = m.all();
    expect(seats(all)[2].props["data-dragging"]).toBe("true");
    seats(all)[0].props.onDrop({ preventDefault() {} });
    expect(get().seats.map((s) => s.role)).toEqual(["Tester", "Builder", "Lead"]);
    expect(get().seats.find((s) => s.lead)?.role).toBe("Lead");
  });

  it("keeps the seats when the kind changes, and shows the kind's own fields", async () => {
    const { m, get } = setup(crew());
    let all = await m.settle();
    const kind = all.find((n) => n.props.label === en("charts.kind") && Array.isArray(n.props.options))!;
    expect(kind.props.value).toBe("hierarchy");
    expect(byLabel(all, en("charts.lead"))).toBeDefined();
    kind.props.onChange("router");
    expect(get().kind).toBe("router");
    expect(get().seats.map((s) => s.role)).toEqual(["Lead", "Builder", "Tester"]);
    all = m.all();
    expect(seats(all)).toHaveLength(3);
    expect(byLabel(all, en("charts.dispatcher"))).toBeDefined();
    expect(textOf(all.find((n) => n.props.className === "charts-problem")!)).toBe(en("charts.problem.no_route"));
    buttonText(all, en("charts.route.add"))!.props.onClick();
    all = m.all();
    byLabel(all, en("charts.route.kind"))!.props.onChange({ target: { value: "bug" } });
    all = m.all();
    expect(all.some((n) => n.props.className === "charts-problem")).toBe(false);
    all.find((n) => n.props.label === en("charts.kind") && Array.isArray(n.props.options))!.props.onChange("pipeline");
    expect(get().seats).toHaveLength(3);
    expect(get().routes).toEqual([{ kind: "bug", seat: "seat-2" }]);
  });

  it("offers the agent's models, or a free field when none is known", async () => {
    const { m, get } = setup(crew());
    let all = await m.settle();
    const model = byLabel(all, en("charts.seat.modelOf", { name: "Lead" }))!;
    expect(model.props.options.map((o: { value: string }) => o.value)).toEqual(["", "opus", "sonnet"]);
    model.props.onChange({ target: { value: "opus" } });
    expect(get().seats[0].model).toBe("opus");
    byLabel(m.all(), en("charts.seat.agentOf", { name: "Lead" }))!.props.onChange({ target: { value: "codex" } });
    all = m.all();
    expect(get().seats[0]).toMatchObject({ agent: "codex", model: null });
    expect(byLabel(all, en("charts.seat.modelOf", { name: "Lead" }))!.props.options).toBeUndefined();
  });

  it("draws the preview from the chart", async () => {
    const all = await mount(Editor, () => ({ chart: crew(), agents: AGENTS, onChange() {} })).settle();
    expect(all.find((n) => n.type === ChartPreview)!.props.chart.seats).toHaveLength(3);
  });
});

describe("ChartPreview", () => {
  it("draws a node per seat and lists the edges for screen readers", () => {
    const all = nodes(mount(Preview, () => ({ chart: crew() })).draw());
    const drawn = all.filter((n) => n.props.className === "charts-node").map((n) => n.props["data-seat"]);
    expect(drawn).toEqual(["seat-1", "seat-2", "seat-3"]);
    const svg = all.find((n) => n.props["data-testid"] === "chart-preview")!;
    expect(svg.props["aria-hidden"]).toBe("true");
    const list = all.find((n) => n.props["aria-label"] === en("charts.preview.list"))!;
    expect(nodes(list.props.children).filter((n) => n.type === "li").map(textOf)).toEqual([
      en("mission.map.edge", { from: "Lead", to: "Builder", grants: en("mission.grant.transcript") }),
      en("mission.map.edge", { from: "Lead", to: "Tester", grants: en("mission.grant.transcript") }),
    ]);
  });

  it("says so when there is nothing to draw", () => {
    const el = mount(Preview, () => ({ chart: { ...crew(), seats: [], edges: [] } })).draw();
    expect(textOf(el as Node)).toBe(en("charts.preview.empty"));
  });
});
