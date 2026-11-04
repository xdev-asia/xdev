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
  const [group, sort, layout] = tree.filter((n) => n.type === Segmented);
  group.props.onChange("project");
  sort.props.onChange("recent");
  layout.props.onChange("compact");
  expect(onPrefs.mock.calls).toEqual([
    [{ ...SIDEBAR_PREFS_DEFAULTS, groupBy: "project" }],
    [{ ...SIDEBAR_PREFS_DEFAULTS, sort: "recent" }],
    [{ ...SIDEBAR_PREFS_DEFAULTS, compactCards: true }],
  ]);
});

it("lists the five groupings", () => {
  const { tree } = panel();
  const group = tree.find((n) => n.type === Segmented)!;
  expect(group.props.options.map((o: { value: string }) => o.value)).toEqual(["activity", "none", "status", "pr", "project"]);
});

it("toggles one card property and keeps the rest", () => {
  const { onPrefs, tree } = panel();
  const boxes = tree.filter((n) => n.type === Checkbox);
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
