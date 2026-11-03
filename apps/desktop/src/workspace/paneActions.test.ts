import { beforeEach, expect, it, vi } from "vitest";
import { equalizeAll, expandFocused, focusedPane, hostOf, movePane, selectInLayout, splitFocused, type LayoutHost } from "./paneActions";
import type { PaneLayout } from "./paneTree";

// The real tree is Lane U1's; these stand in so the actions are tested for what they call.
const tree = vi.hoisted(() => ({
  leaves: vi.fn(),
  neighbour: vi.fn(),
  focusPane: vi.fn(),
  toggleExpand: vi.fn(),
  equalize: vi.fn(),
  selectTab: vi.fn(),
  splitPane: vi.fn(),
  removeTab: vi.fn(),
}));
vi.mock("./paneTree", () => tree);

const leaf = (id: string, tabs: string[], active = tabs[0]) => ({ kind: "leaf" as const, id, tabs, active });
const layout = (over: Partial<PaneLayout> = {}): PaneLayout =>
  ({ root: { kind: "split", id: "s", dir: "right", children: [], sizes: [] }, focused: "p1", expanded: null, ...over }) as PaneLayout;

let current: PaneLayout | null;
const host: LayoutHost = { layout: () => current, setLayout: vi.fn((_w, next) => void (current = next)) };
const W = "/wt";

beforeEach(() => {
  vi.clearAllMocks();
  current = layout();
  tree.leaves.mockReturnValue([leaf("p1", ["a", "b"], "b"), leaf("p2", ["c"])]);
  tree.neighbour.mockImplementation((l: PaneLayout, _f: string, step: number) => (step === 1 ? "p2" : "p2"));
  tree.focusPane.mockImplementation((l: PaneLayout, pane: string) => ({ ...l, focused: pane }));
  tree.toggleExpand.mockImplementation((l: PaneLayout, pane: string) => ({ ...l, expanded: l.expanded === pane ? null : pane }));
  tree.equalize.mockImplementation((l: PaneLayout) => ({ ...l }));
  tree.selectTab.mockImplementation((l: PaneLayout) => ({ ...l, focused: "p2" }));
  tree.splitPane.mockImplementation((l: PaneLayout, pane: string) => ({ ...l, focused: `split-of-${pane}` }));
  tree.removeTab.mockImplementation((l: PaneLayout) => ({ ...l, expanded: "removed" }));
});

it("hostOf needs both layout and setLayout", () => {
  expect(hostOf({})).toBeNull();
  expect(hostOf({ layout() {} })).toBeNull();
  expect(hostOf(host)).toBe(host);
});

it("focusedPane reads the focused leaf's tabs and front tab", () => {
  expect(focusedPane(host, W)).toEqual({ tabs: ["a", "b"], active: "b" });
  current = null;
  expect(focusedPane(host, W)).toBeNull();
  expect(focusedPane(null, W)).toBeNull();
});

it("selectInLayout stores the layout that selectTab returns", () => {
  expect(selectInLayout(host, W, "c")).toBe(true);
  expect(tree.selectTab).toHaveBeenCalledWith(expect.anything(), "c");
  expect(host.setLayout).toHaveBeenCalledWith(W, expect.objectContaining({ focused: "p2" }));
  current = null;
  expect(selectInLayout(host, W, "c")).toBe(false);
});

it("splitFocused opens the tab, takes it out of the focused pane and gives it a new one", () => {
  tree.leaves.mockReturnValue([leaf("p1", ["a", "n"])]);
  const open = vi.fn(() => "n");
  expect(splitFocused(host, W, "down", open)).toBe(true);
  expect(open).toHaveBeenCalled();
  expect(tree.removeTab).toHaveBeenCalledWith(expect.anything(), "n");
  expect(tree.splitPane).toHaveBeenCalledWith(expect.anything(), "p1", "down", "n");
  expect(current?.focused).toBe("split-of-p1");
});

it("splitFocused does nothing without a layout, and when the tab did not start", () => {
  current = null;
  const open = vi.fn(() => "n");
  expect(splitFocused(host, W, "right", open)).toBe(false);
  expect(open).not.toHaveBeenCalled();
  current = layout();
  expect(splitFocused(host, W, "right", () => null)).toBe(false);
  expect(tree.splitPane).not.toHaveBeenCalled();
});

it("movePane focuses the neighbour and returns its front tab", () => {
  expect(movePane(host, W, 1)).toBe("c");
  expect(tree.neighbour).toHaveBeenCalledWith(expect.anything(), "p1", 1);
  expect(current?.focused).toBe("p2");
  expect(current?.expanded).toBeNull();
});

it("movePane moves the expansion along, so focus never lands on a hidden pane", () => {
  current = layout({ expanded: "p1" });
  expect(movePane(host, W, -1)).toBe("c");
  expect(current).toMatchObject({ focused: "p2", expanded: "p2" });
});

it("movePane with one pane does nothing", () => {
  tree.neighbour.mockReturnValue("p1");
  expect(movePane(host, W, 1)).toBeNull();
  expect(host.setLayout).not.toHaveBeenCalled();
  current = null;
  expect(movePane(host, W, 1)).toBeNull();
});

it("expandFocused toggles the focused pane, twice restores", () => {
  expect(expandFocused(host, W)).toBe(true);
  expect(current?.expanded).toBe("p1");
  expandFocused(host, W);
  expect(current?.expanded).toBeNull();
  current = null;
  expect(expandFocused(host, W)).toBe(false);
});

it("equalizeAll calls equalize, and stays out when nothing changed", () => {
  const l = layout();
  current = l;
  tree.equalize.mockReturnValueOnce(l);
  expect(equalizeAll(host, W)).toBe(true);
  expect(host.setLayout).not.toHaveBeenCalled();
  equalizeAll(host, W);
  expect(host.setLayout).toHaveBeenCalledTimes(1);
  current = null;
  expect(equalizeAll(host, W)).toBe(false);
});
