import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Checkbox, Popover, Segmented } from "@xdev-asia/ui";
import { SIDEBAR_PREFS_DEFAULTS } from "@/mockSettings";
import { translate } from "@/i18n";
import { SidebarOptions, SidebarOptionsPanel } from "./SidebarOptions";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = value; }];
  },
}));
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ t: (key: string) => translate("en", key) }) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}

beforeEach(() => { hooks.values = []; hooks.cursor = 0; });

function panel(): { onPrefs: ReturnType<typeof vi.fn>; tree: Node[] } {
  const onPrefs = vi.fn();
  return { onPrefs, tree: nodes(SidebarOptionsPanel({ prefs: SIDEBAR_PREFS_DEFAULTS, onPrefs })) };
}

it("changes only the group, the sort or the layout it was asked for", () => {
  const { onPrefs, tree } = panel();
  const [group, sort, projects, layout] = tree.filter((n) => n.type === Segmented);
  group.props.onChange("project");
  sort.props.onChange("recent");
  projects.props.onChange("recent");
  layout.props.onChange("compact");
  expect(onPrefs.mock.calls).toEqual([
    [{ ...SIDEBAR_PREFS_DEFAULTS, groupBy: "project" }],
    [{ ...SIDEBAR_PREFS_DEFAULTS, sort: "recent" }],
    [{ ...SIDEBAR_PREFS_DEFAULTS, projectOrder: "recent" }],
    [{ ...SIDEBAR_PREFS_DEFAULTS, compactCards: true }],
  ]);
});

it("lists the five sorts and explains Smart and Manual", () => {
  const { tree } = panel();
  const sort = tree.filter((n) => n.type === Segmented)[1];
  expect(sort.props.options.map((o: { value: string }) => o.value)).toEqual(["manual", "recent", "name", "smart", "project"]);
  expect(sort.props.options.map((o: { label: string }) => o.label)).toEqual(["Manual", "Recent", "Name", "Smart", "Project"]);
  const hint = (sortValue: "manual" | "smart" | "name") => nodes(SidebarOptionsPanel({ prefs: { ...SIDEBAR_PREFS_DEFAULTS, sort: sortValue }, onPrefs: () => {} })).filter((n) => n.type === "small").map((n) => n.props.children).filter((text) => text !== "Also show pinned worktrees in their own group.");
  expect(hint("smart")).toEqual(["Agents that need attention, then most recent activity."]);
  expect(hint("manual")).toEqual(["Drag worktrees to arrange them within each group."]);
  expect(hint("name")).toEqual([]);
});

it("lists the five groupings", () => {
  const { tree } = panel();
  const group = tree.find((n) => n.type === Segmented)!;
  expect(group.props.options.map((o: { value: string }) => o.value)).toEqual(["activity", "none", "status", "pr", "project"]);
});

it("toggles one card property and keeps the rest", () => {
  const { onPrefs, tree } = panel();
  const boxes = nodes(tree.find((n) => n.props.role === "group")!.props.children).filter((n) => n.type === Checkbox);
  expect(boxes).toHaveLength(9);
  boxes[0].props.onChange({ target: { checked: false } });
  const [next] = onPrefs.mock.calls[0];
  expect(Object.values(next.card).filter((v) => v === false)).toHaveLength(1);
  expect({ ...next, card: SIDEBAR_PREFS_DEFAULTS.card }).toEqual(SIDEBAR_PREFS_DEFAULTS);
});

it("opens from its button and closes on the popover's close", () => {
  const first = nodes(SidebarOptions({ prefs: SIDEBAR_PREFS_DEFAULTS, onPrefs() {} }));
  const pop = first.find((n) => n.type === Popover)!;
  expect(pop.props.open).toBe(false);
  pop.props.trigger({}).props.onClick();
  hooks.cursor = 0;
  const open = nodes(SidebarOptions({ prefs: SIDEBAR_PREFS_DEFAULTS, onPrefs() {} })).find((n) => n.type === Popover)!;
  expect(open.props.open).toBe(true);
  open.props.onClose();
  hooks.cursor = 0;
  expect(nodes(SidebarOptions({ prefs: SIDEBAR_PREFS_DEFAULTS, onPrefs() {} })).find((n) => n.type === Popover)!.props.open).toBe(false);
});

it("offers Pinned in groups with its hint and toggles only that pref", () => {
  const { onPrefs, tree } = panel();
  const box = tree.filter((n) => n.type === Checkbox).find((n) => n.props.label === "Pinned in groups")!;
  expect(box.props.checked).toBe(false);
  box.props.onChange({ target: { checked: true } });
  expect(onPrefs).toHaveBeenCalledWith({ ...SIDEBAR_PREFS_DEFAULTS, pinnedInGroups: true });
  expect(tree.some((n) => n.type === "small" && n.props.children === "Also show pinned worktrees in their own group.")).toBe(true);
});

it("lists the two project orders", () => {
  const { tree } = panel();
  const order = tree.filter((n) => n.type === Segmented)[2];
  expect(order.props.options.map((o: { value: string }) => o.value)).toEqual(["manual", "recent"]);
  expect(order.props.value).toBe("manual");
});
