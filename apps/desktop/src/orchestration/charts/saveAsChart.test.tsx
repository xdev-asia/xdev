import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Account, Api, Chart, ProfilesView, Squad } from "@/api";
import { translate } from "@/i18n";
import { mount, textOf, tick, type Node } from "@/kit/testHooks";
import { createMockCharts } from "@/mockCharts";
import { createMockMission } from "@/mockMission";
import { MissionControl, type MissionControlProps } from "../MissionControl";
import { ChartEditor } from "./ChartEditor";
import { ChartsDialog, type ChartsDialogProps } from "./ChartsDialog";
import { chartItems, onChartsOpen } from "./chartEvents";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const Mission = MissionControl as unknown as (p: MissionControlProps) => ReactElement;
const Charts = ChartsDialog as unknown as (p: ChartsDialogProps) => ReactElement;
const button = (all: Node[], text: string) => all.find((n) => typeof n.props.onClick === "function" && textOf(n) === text);
const profiles: Pick<Api, "profiles"> = {
  profiles: async () => ({ profiles: [{ profile: { id: "claude", name: "Claude", enabled: true }, installed: true, models: [] }] }) as unknown as ProfilesView,
};

describe("save as chart", () => {
  it("turns the team map's tabs and links into a chart draft", async () => {
    const drafts: (Chart | null)[] = [];
    const m = mount(Mission, () => ({
      api: createMockMission(() => 50_000_000),
      view: "map" as const,
      onView() {},
      onClose() {},
      onFocusTab() {},
      onHandoff() {},
      pollMs: 3_600_000,
      onOpenCharts: (d: Chart | null) => void drafts.push(d),
    }));
    const all = await m.settle();
    button(all, en("charts.saveAsChart"))!.props.onClick();
    const draft = drafts[0]!;
    expect(draft.kind).toBe("hierarchy");
    expect(draft.name).toBe(en("charts.fromTeamName"));
    expect(draft.seats.map((s) => s.role).sort()).toEqual(["Builder", "Docs writer", "Lead", "Reviewer"]);
    expect(draft.seats.find((s) => s.lead)?.role).toBe("Lead");
    expect(draft.edges).toHaveLength(1);
    button(all, en("charts.palette.open"))!.props.onClick();
    expect(drafts[1]).toBeNull();
  });

  it("opens the draft in the editor and saves it to the list", async () => {
    const charts = createMockCharts({ squad: async () => ({}) as Squad, accounts: () => [] as Account[] });
    const draft: Chart = {
      id: "",
      name: "Team",
      kind: "hierarchy",
      seats: [
        { id: "seat-1", role: "Lead", agent: "claude", model: null, prompt: "", lead: true },
        { id: "seat-2", role: "Builder", agent: "claude", model: null, prompt: "", lead: false },
      ],
      edges: [{ from: "seat-1", to: "seat-2", transcript: true, screen: false }],
      routes: [],
      createdMs: 0,
      updatedMs: 0,
    };
    const m = mount(Charts, () => ({ api: { ...charts, ...profiles }, draft, onClose() {}, onRun: async () => null }));
    let all = await m.settle();
    const dialog = all[0];
    expect(dialog.props.title).toBe(en("charts.newTitle"));
    expect(all.find((n) => n.type === ChartEditor)!.props.chart.seats).toHaveLength(2);
    dialog.props.onConfirm();
    await tick();
    await tick();
    all = m.all();
    expect(all[0].props.title).toBe(en("charts.title"));
    expect(textOf(all.find((n) => n.props.role === "status")!)).toBe(en("charts.saved", { name: "Team" }));
    expect((await charts.chartsList()).map((c) => [c.name, c.seats.length])).toEqual([["Team", 2]]);
  });

  it("is in the palette", () => {
    const seen: (Chart | null)[] = [];
    const off = onChartsOpen((o) => void seen.push(o.draft));
    const [item] = chartItems(en);
    expect(item.title).toBe("Open team charts");
    item.run();
    off();
    expect(seen).toEqual([null]);
  });
});
