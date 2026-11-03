import { expect, it } from "vitest";
import en from "@/i18n/en.json";
import viText from "@/i18n/vi.json";
import type { MenuItem } from "@/ui/ContextMenu";
import type { Tab } from "./sessions";
import { tabMenuItems, type TabMenuContext } from "./tabMenu";

const tab = (id: string, over: Partial<Tab> = {}) => ({ id, pinned: false, color: "none", ...over }) as Tab;

function setup(over: Partial<TabMenuContext> = {}, tabs: Tab[] = [tab("a"), tab("b"), tab("c")], at = 1) {
  const calls: string[] = [];
  const ctx: TabMenuContext = {
    tab: tabs[at],
    tabs,
    canMoveToSplit: true,
    split: (d) => void calls.push(`split:${d}`),
    moveToSplit: (d) => void calls.push(`move:${d}`),
    setPinned: (p) => void calls.push(`pin:${p}`),
    copyTabId: () => void calls.push("copyId"),
    changeTitle: () => void calls.push("title"),
    setColor: (c) => void calls.push(`color:${c}`),
    close: () => void calls.push("close"),
    closeOthers: () => void calls.push("others"),
    closeToRight: () => void calls.push("right"),
    ...over,
  };
  const items = tabMenuItems(ctx);
  const find = (id: string) => items.find((i) => i.id === id) as MenuItem;
  return { calls, items, find };
}
const ids = (items: MenuItem[]) => items.map((i) => (i.kind === "separator" ? "-" : i.id));

it("lists the items in SCR-14 order", () => {
  expect(ids(setup().items)).toEqual([
    "splitRight", "splitDown", "moveToSplit", "-",
    "pin", "copyTabId", "-",
    "changeTitle", "color", "-",
    "close", "closeOthers", "closeToRight",
  ]);
  expect(ids(setup().find("moveToSplit").children!)).toEqual(["moveRight", "moveDown"]);
});

it("the pin item toggles its label and its call", () => {
  const free = setup();
  expect(free.find("pin").labelKey).toBe("tabMenu.pin");
  free.find("pin").run!();
  const pinned = setup({}, [tab("a"), tab("b", { pinned: true }), tab("c")]);
  expect(pinned.find("pin").labelKey).toBe("tabMenu.unpin");
  pinned.find("pin").run!();
  expect([...free.calls, ...pinned.calls]).toEqual(["pin:true", "pin:false"]);
});

it("the colour submenu has none and ten swatches, marks the current one and sets it", () => {
  const { find, calls } = setup({}, [tab("a"), tab("b", { color: "c3" }), tab("c")]);
  const colors = find("color").children!;
  expect(colors).toHaveLength(11);
  expect(colors.filter((c) => c.checked).map((c) => c.id)).toEqual(["c3"]);
  expect(colors[0].swatch).toBeUndefined();
  expect(colors[3].swatch).toBe("--x-tab-color-3");
  expect(colors[3].labelKey).toBe("tabMenu.color.c3");
  colors[5].run!();
  expect(calls).toEqual(["color:c5"]);
});

it("Move to Split is disabled for a tab alone in its pane", () => {
  const alone = setup({ canMoveToSplit: false });
  expect(alone.find("moveToSplit").disabled).toBe(true);
  expect(setup().find("moveToSplit").disabled).toBeFalsy();
});

it("each item calls its context method", () => {
  const { calls, find } = setup();
  find("splitRight").run!();
  find("splitDown").run!();
  find("moveToSplit").children![0].run!();
  find("moveToSplit").children![1].run!();
  find("copyTabId").run!();
  find("changeTitle").run!();
  find("close").run!();
  find("closeOthers").run!();
  find("closeToRight").run!();
  expect(calls).toEqual(["split:right", "split:down", "move:right", "move:down", "copyId", "title", "close", "others", "right"]);
});

it("Close Others and Close to the Right are disabled when pinned or missing tabs leave nothing to close", () => {
  const only = setup({}, [tab("a")], 0);
  expect(only.find("closeOthers").disabled).toBe(true);
  expect(only.find("closeToRight").disabled).toBe(true);
  const shielded = setup({}, [tab("a"), tab("b", { pinned: true }), tab("c", { pinned: true })], 0);
  expect(shielded.find("closeOthers").disabled).toBe(true);
  expect(shielded.find("closeToRight").disabled).toBe(true);
  const last = setup({}, [tab("a"), tab("b")], 1);
  expect(last.find("closeOthers").disabled).toBeFalsy();
  expect(last.find("closeToRight").disabled).toBe(true);
});

it("every label exists in en and vi", () => {
  const walk = (items: MenuItem[]): string[] => items.flatMap((i) => (i.kind === "separator" ? [] : [i.labelKey, ...walk(i.children ?? [])]));
  for (const key of walk(setup().items)) {
    expect(en, key).toHaveProperty([key]);
    expect(viText, key).toHaveProperty([key]);
  }
});
