import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { translate } from "@/i18n";
import { mount, textOf, tick, type Node } from "@/kit/testHooks";
import { createMockMission } from "@/mockMission";
import { MissionControl, dotState, type MissionControlProps } from "./MissionControl";
import { TeamMap } from "./TeamMap";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const Panel = MissionControl as unknown as (p: MissionControlProps) => ReactElement;
const NOW = 50_000_000;

function setup(over: Partial<MissionControlProps> = {}) {
  const api = createMockMission(() => NOW);
  const calls = { focus: [] as string[], handoff: [] as string[] };
  const m = mount(Panel, () => ({
    api,
    view: "tabs" as const,
    onView() {},
    onClose() {},
    onFocusTab: (id: string) => void calls.focus.push(id),
    onHandoff: (id: string) => void calls.handoff.push(id),
    pollMs: 3_600_000,
    ...over,
  }));
  return { api, m, calls };
}

const byLabel = (all: Node[], label: string) => all.find((n) => n.props["aria-label"] === label);
const rows = (all: Node[]) => all.filter((n) => n.type === "li" && n.props.className === "mc-row");
const status = (all: Node[]) => all.find((n) => n.props.role === "status");

describe("MissionControl", () => {
  it("lists stuck tabs first, saying why, with task and last output", async () => {
    const { m } = setup();
    const all = await m.settle();
    const list = rows(all);
    expect(list.map((r) => r.props["aria-label"])).toEqual(["Builder", "Reviewer", "Docs writer", "Lead"]);
    expect(list[0].props["data-stuck"]).toBe("true");
    expect(list[2].props["data-stuck"]).toBeUndefined();
    const text = list.map((r) => textOf(r));
    expect(text[0]).toContain(en("mission.stuck.silent"));
    expect(text[0]).toContain(en("mission.task", { task: "Add retry to fetchJson" }));
    expect(text[0]).toContain(en("mission.lastOutput", { ago: "25 min" }));
    expect(text[1]).toContain(en("mission.stuck.waiting"));
  });

  it("nudges a stuck worker, announces it and shows when it was nudged", async () => {
    const { api, m } = setup();
    await m.settle();
    byLabel(m.all(), en("mission.nudgeLabel", { name: "Builder" }))!.props.onClick();
    await tick();
    await tick();
    const all = m.all();
    expect(api.__nudges().map((n) => n.tab)).toEqual(["demo-builder"]);
    expect(status(all)!.props.children).toBe(en("mission.nudged", { name: "Builder" }));
    expect(textOf(rows(all)[0])).toContain(en("mission.lastNudge", { ago: en("ago.now") }));
  });

  it("links two tabs with both grants off, then keeps a transcript grant", async () => {
    const { api, m } = setup();
    await m.settle();
    byLabel(m.all(), en("mission.linkTo", { name: "Lead" }))!.props.onChange({ target: { value: "demo-review" } });
    await tick();
    await tick();
    const label = en("mission.grantLabel", { grant: en("mission.grant.transcript"), name: "Reviewer" });
    const screen = en("mission.grantLabel", { grant: en("mission.grant.screen"), name: "Reviewer" });
    expect(byLabel(m.all(), label)!.props.checked).toBe(false);
    expect(byLabel(m.all(), screen)!.props.checked).toBe(false);
    byLabel(m.all(), label)!.props.onChange({ target: { checked: true } });
    await tick();
    await tick();
    expect(byLabel(m.all(), label)!.props.checked).toBe(true);
    const stored = (await api.orchestrationMission()).links.find((l) => l.to === "demo-review");
    expect(stored).toMatchObject({ from: "demo-lead", transcript: true, screen: false });
  });

  it("warns in one line when the screen grant is on", async () => {
    const { m } = setup();
    await m.settle();
    const warning = () => m.all().filter((n) => n.props.className === "mc-warn");
    expect(warning()).toHaveLength(0);
    byLabel(m.all(), en("mission.grantLabel", { grant: en("mission.grant.screen"), name: "Builder" }))!.props.onChange({ target: { checked: true } });
    await tick();
    await tick();
    expect(warning()).toHaveLength(1);
    expect(warning()[0].props.children).toBe(en("mission.screenWarning"));
  });

  it("relinks to another tab and resets its grants", async () => {
    const { api, m } = setup();
    await m.settle();
    byLabel(m.all(), en("mission.relink", { name: "Builder" }))!.props.onChange({ target: { value: "demo-docs" } });
    await tick();
    await tick();
    const links = (await api.orchestrationMission()).links;
    expect(links).toEqual([expect.objectContaining({ from: "demo-lead", to: "demo-docs", transcript: false })]);
  });

  it("stops a worker only on the second press, and focuses and hands off from a row", async () => {
    const { api, m, calls } = setup();
    await m.settle();
    byLabel(m.all(), en("mission.stopLabel", { name: "Docs writer" }))!.props.onClick();
    expect(status(m.all())!.props.children).toBe(en("mission.stopConfirmHint", { name: "Docs writer" }));
    expect((await api.orchestrationMission()).tabs).toHaveLength(4);
    byLabel(m.all(), en("mission.stopConfirmLabel", { name: "Docs writer" }))!.props.onClick();
    await tick();
    await tick();
    expect((await api.orchestrationMission()).tabs.map((t) => t.id)).not.toContain("demo-docs");
    const focus = m.all().filter((n) => typeof n.props.children === "string" && n.props.children === en("mission.focus"));
    focus[0].props.onClick();
    byLabel(m.all(), en("mission.handoffLabel", { name: "Builder" }))!.props.onClick();
    expect(calls).toEqual({ focus: ["demo-builder"], handoff: ["demo-builder"] });
  });

  it("saves the stuck threshold and nudge text", async () => {
    const { api, m } = setup();
    await m.settle();
    const field = () => m.all().find((n) => n.props.label === en("mission.settings.minutes"))!;
    const nudge = () => m.all().find((n) => n.props.label === en("mission.settings.nudge"))!;
    expect(field().props.value).toBe("10");
    field().props.onChange({ target: { value: "3" } });
    nudge().props.onChange({ target: { value: "Status, please" } });
    m.all().find((n) => n.props.children === en("mission.settings.save"))!.props.onClick();
    await tick();
    await tick();
    expect((await api.orchestrationMission()).settings).toEqual({ stuckMinutes: 3, nudgePrompt: "Status, please" });
    expect(status(m.all())!.props.children).toBe(en("mission.settings.saved"));
  });

  it("shows the team map on its view with the same tabs and links", async () => {
    const { m } = setup({ view: "map" });
    const all = await m.settle();
    const map = all.find((n) => n.type === TeamMap)!;
    expect(map.props.links).toEqual([expect.objectContaining({ from: "demo-lead", to: "demo-builder" })]);
    expect(map.props.tabs.map((t: { label: string }) => t.label)).toContain("Lead");
  });

  it("maps reported statuses to dots", () => {
    expect(dotState({ status: "needs-you", exited: false })).toBe("waiting");
    expect(dotState({ status: "working", exited: true })).toBe("exited");
    expect(dotState({ status: "whatever", exited: false })).toBe("idle");
  });
});
