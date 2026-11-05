import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Icon, Spinner } from "@xdev-asia/ui";
import { translate } from "@/i18n";
import { dropBefore, middleClick } from "./TabStrip";
import { TabIndicator } from "./TabIndicator";
import { TabHoverCard } from "./TabHoverCard";
import { reorderTabs } from "./sessions";
import { single, splitPane, leaves } from "./paneTree";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string) => translate("en", key) }) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}

it("reorderTabs moves a tab before another or to the end", () => {
  const tabs = ["a", "b", "c", "d"];
  expect(reorderTabs(tabs, "d", "b")).toEqual(["a", "d", "b", "c"]);
  expect(reorderTabs(tabs, "a", null)).toEqual(["b", "c", "d", "a"]);
  expect(reorderTabs(tabs, "b", "a")).toEqual(["b", "a", "c", "d"]);
});

it("reorderTabs keeps the same array when nothing moves", () => {
  const tabs = ["a", "b", "c"];
  expect(reorderTabs(tabs, "b", "b")).toBe(tabs);
  expect(reorderTabs(tabs, "b", "c")).toBe(tabs);
  expect(reorderTabs(tabs, "c", null)).toBe(tabs);
  expect(reorderTabs(tabs, "x", "a")).toBe(tabs);
  expect(reorderTabs(tabs, "a", "x")).toBe(tabs);
});

it("dropBefore picks the tab itself or the next one", () => {
  const ids = ["a", "b", "c"];
  expect(dropBefore(ids, "b", false)).toBe("b");
  expect(dropBefore(ids, "b", true)).toBe("c");
  expect(dropBefore(ids, "c", true)).toBeNull();
});

it("splitPane can put the new pane first", () => {
  const l = splitPane(single("a"), "p1", "right", "b", true);
  expect(leaves(l).map((n) => (n.kind === "leaf" ? n.tabs : []))).toEqual([["b"], ["a"]]);
});

it("middle-click closes through the close path; other buttons and pinned tabs do not", () => {
  const closed: string[] = [];
  const h = middleClick("t1", false, (id) => void closed.push(id));
  let prevented = 0;
  const ev = (button: number) => ({ button, preventDefault: () => void prevented++ });
  h.onMouseDown(ev(1));
  expect(prevented).toBe(1);
  h.onMouseDown(ev(0));
  expect(prevented).toBe(1);
  h.onAuxClick(ev(0));
  h.onAuxClick(ev(2));
  expect(closed).toEqual([]);
  h.onAuxClick(ev(1));
  expect(closed).toEqual(["t1"]);
  middleClick("t2", true, (id) => void closed.push(id)).onAuxClick(ev(1));
  expect(closed).toEqual(["t1"]);
});

it("the indicator is a spinner while working, a question icon when it needs you, else the dot", () => {
  const working = nodes(TabIndicator({ status: "working", label: "Working" }));
  expect(working.some((n) => n.type === Spinner && n.props.size === "sm")).toBe(true);
  const needs = nodes(TabIndicator({ status: "needs-you", label: "Needs you" }));
  expect(needs.some((n) => n.type === Icon && n.props.name === "help")).toBe(true);
  expect(needs.some((n) => n.type === Spinner)).toBe(false);
  const idle = nodes(TabIndicator({ status: "idle", label: "Idle" }));
  expect(idle[0].props.className).toBe("ws-glyph");
  expect(idle[0].props["data-status"]).toBe("idle");
  expect(TabIndicator({ status: null, label: "" })).toBeNull();
});

it("the hover card shows title, agent, status and folder", () => {
  const card = TabHoverCard({
    id: "c1",
    at: { x: 10, y: 20 },
    labels: { agent: "Agent", status: "Status", cwd: "Folder" },
    data: { title: "Fix bug", agent: "Claude", status: "Working", cwd: "/work/repo" },
  });
  const text = nodes(card).flatMap((n) => (typeof n.props.children === "string" ? [n.props.children] : []));
  expect(text).toEqual(expect.arrayContaining(["Fix bug", "Claude", "Working", "/work/repo", "Agent", "Status", "Folder"]));
  expect(card.props.role).toBe("tooltip");
  expect(card.props.id).toBe("c1");
});
