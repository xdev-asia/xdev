import type { ReactElement } from "react";
import { expect, it, vi } from "vitest";
import type { TabLink } from "@/api";
import { translate } from "@/i18n";
import { mount, type Node } from "@/kit/testHooks";
import { TeamMap, type TeamMapProps } from "./TeamMap";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const Map = TeamMap as unknown as (p: TeamMapProps) => ReactElement;
const link = (from: string, to: string, transcript = false, screen = false): TabLink => ({ from, to, transcript, screen, createdMs: 0, updatedMs: 0 });
const tabs = [
  { id: "a", label: "Lead" },
  { id: "b", label: "Builder" },
  { id: "c", label: "Reviewer" },
];
const key = (k: string) => ({ key: k, preventDefault() {} });
const buttons = (all: Node[]) => all.filter((n) => n.props.role === "button");
const focusable = (all: Node[]) => buttons(all).find((n) => n.props.tabIndex === 0)!.props["aria-label"];

it("draws an edge per link labelled with its grants, both off by default", () => {
  const m = mount(Map, () => ({ tabs, links: [link("a", "b"), link("a", "c", true, true)], onFocusTab() {} }));
  const all = m.all();
  const labels = all.filter((n) => n.props.className === "mc-edge-label").map((n) => n.props.children);
  expect(labels).toEqual([en("mission.map.noGrants"), `${en("mission.grant.transcript")}, ${en("mission.grant.screen")}`]);
  expect(all.some((n) => n.props["data-testid"] === "edge-a-b")).toBe(true);
});

it("moves between nodes with the arrow keys and focuses a tab with Enter or a click", () => {
  const focused: string[] = [];
  const m = mount(Map, () => ({ tabs, links: [link("a", "b"), link("a", "c")], onFocusTab: (id: string) => void focused.push(id) }));
  expect(focusable(m.all())).toBe(en("mission.map.node", { name: "Lead" }));
  buttons(m.all())[0].props.onKeyDown(key("ArrowRight"));
  expect(focusable(m.all())).toBe(en("mission.map.node", { name: "Builder" }));
  const builder = buttons(m.all()).find((n) => n.props.tabIndex === 0)!;
  builder.props.onKeyDown(key("ArrowDown"));
  expect(focusable(m.all())).toBe(en("mission.map.node", { name: "Reviewer" }));
  buttons(m.all()).find((n) => n.props.tabIndex === 0)!.props.onKeyDown(key("Enter"));
  buttons(m.all())[0].props.onClick();
  expect(focused).toEqual(["c", "a"]);
});

it("lists the links as text for screen readers", () => {
  const m = mount(Map, () => ({ tabs, links: [link("a", "b", true)], onFocusTab() {} }));
  const list = m.all().find((n) => n.type === "ul" && n.props.className === "x-sr-only")!;
  const items = (list.props.children as unknown[]).flat().filter(Boolean) as Node[];
  expect(items.map((i) => i.props.children)).toEqual([en("mission.map.edge", { from: "Lead", to: "Builder", grants: en("mission.grant.transcript") })]);
});

it("says so when there is nothing to draw", () => {
  const m = mount(Map, () => ({ tabs: [], links: [], onFocusTab() {} }));
  expect((m.draw() as Node).props.children).toBe(en("mission.map.empty"));
});
