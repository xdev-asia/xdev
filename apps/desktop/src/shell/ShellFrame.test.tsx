import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { ActivityBar } from "@xdev-asia/ui";
import { ShellFrame } from "./ShellFrame";

type Node = ReactElement<Record<string, any>>;
function find(value: unknown, type: unknown): Node | undefined {
  if (Array.isArray(value)) return value.map((v) => find(v, type)).find(Boolean);
  if (!value || typeof value !== "object" || !("props" in value)) return undefined;
  const node = value as Node;
  return node.type === type ? node : find(node.props.children, type);
}
const labels = { workspace: "Workspace", docs: "Docs", automations: "Automations", rail: "Places", sidebar: "Sidebar", openNav: "Open", closeNav: "Close", skipToContent: "Skip" };
const frame = (over: Partial<Parameters<typeof ShellFrame>[0]> = {}) =>
  ShellFrame({ titlebar: null, view: "workspace", onView: () => {}, automations: true, labels, sidebarOpen: true, navOpen: false, onNavOpenChange: () => {}, brand: null, sidebar: null, crumbs: null, actions: null, footer: null, children: null, ...over });

it("the rail lists Automations as an extra item and highlights it on its page", () => {
  const bar = find(frame({ view: "automations" }), ActivityBar)!;
  expect(bar.props.extraItems).toEqual([{ id: "automations", icon: "automation", label: "Automations" }]);
  expect(bar.props.active).toBe("automations");
});

it("without the Automations place the rail has no extra item", () => {
  expect(find(frame({ automations: false }), ActivityBar)!.props.extraItems).toBeUndefined();
});

it("a rail pick goes to its view", () => {
  const onView = vi.fn();
  const bar = find(frame({ onView }), ActivityBar)!;
  bar.props.onSelect("automations");
  bar.props.onSelect("docs");
  bar.props.onSelect("terminal");
  expect(onView.mock.calls.map((c) => c[0])).toEqual(["automations", "docs", "workspace"]);
});
