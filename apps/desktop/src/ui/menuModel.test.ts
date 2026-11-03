import { expect, it, vi } from "vitest";
import { attachDismiss, clampToWindow, initialMenu, menuKey, type MenuState } from "./menuModel";
import type { MenuItem } from "./ContextMenu";

const label = (id: string) => `label.${id}`;
const t = (key: string) => key.replace("label.", "").replace(/^\w/, (c) => c.toUpperCase());
const run = vi.fn();
const items: MenuItem[] = [
  { id: "copy", labelKey: "label.copy", run },
  { id: "paste", labelKey: "label.paste", disabled: true },
  { id: "sep", labelKey: "", kind: "separator" },
  { id: "select", labelKey: "label.select", run },
  {
    id: "more",
    labelKey: "label.more",
    children: [
      { id: "a", labelKey: "label.alpha", run },
      { id: "b", labelKey: "label.beta", disabled: true },
      { id: "c", labelKey: "label.gamma", run },
    ],
  },
];
void label;
const press = (state: MenuState, key: string) => menuKey(state, key, items, t);

it("starts on the first enabled item", () => {
  expect(initialMenu(items)).toEqual({ path: [0] });
  expect(initialMenu([{ id: "x", labelKey: "x", disabled: true }])).toEqual({ path: [] });
});

it("arrows skip disabled items and separators and wrap", () => {
  let s = initialMenu(items);
  s = press(s, "ArrowDown").state;
  expect(s.path).toEqual([3]);
  s = press(s, "ArrowDown").state;
  expect(s.path).toEqual([4]);
  s = press(s, "ArrowDown").state;
  expect(s.path).toEqual([0]);
  s = press(s, "ArrowUp").state;
  expect(s.path).toEqual([4]);
});

it("Home and End jump to the first and last enabled item", () => {
  expect(press({ path: [3] }, "Home").state.path).toEqual([0]);
  expect(press({ path: [0] }, "End").state.path).toEqual([4]);
});

it("Enter runs an item and closes; a disabled item does nothing", () => {
  expect(press({ path: [0] }, "Enter")).toMatchObject({ effect: { kind: "run", item: items[0] } });
  expect(press({ path: [1] }, "Enter").effect).toBeUndefined();
});

it("Right opens a submenu on its first enabled item, Left closes it", () => {
  const open = press({ path: [4] }, "ArrowRight").state;
  expect(open.path).toEqual([4, 0]);
  expect(press(open, "ArrowDown").state.path).toEqual([4, 2]);
  expect(press(open, "ArrowLeft").state.path).toEqual([4]);
  // Enter on a parent opens it instead of running.
  expect(press({ path: [4] }, "Enter").state.path).toEqual([4, 0]);
  // Right on a leaf does nothing.
  expect(press({ path: [0] }, "ArrowRight").state.path).toEqual([0]);
  // Left at the top level does nothing.
  expect(press({ path: [0] }, "ArrowLeft").state.path).toEqual([0]);
});

it("Escape closes the submenu first, then the menu", () => {
  expect(press({ path: [4, 2] }, "Escape").state.path).toEqual([4]);
  expect(press({ path: [4, 2] }, "Escape").effect).toBeUndefined();
  expect(press({ path: [4] }, "Escape").effect).toEqual({ kind: "close" });
});

it("a submenu item runs from Enter", () => {
  expect(press({ path: [4, 2] }, "Enter")).toMatchObject({ effect: { kind: "run", item: items[4].children![2] } });
});

it("type-ahead moves to the next enabled label that starts with the typed letters", () => {
  expect(press({ path: [0] }, "s").state.path).toEqual([3]);
  // Same letter again cycles; with one match it stays.
  expect(press({ path: [3] }, "s").state.path).toEqual([3]);
  // Disabled items are not matched.
  expect(press({ path: [0] }, "p").state.path).toEqual([0]);
  // Typing in a submenu searches that level.
  expect(press({ path: [4, 0] }, "g").state.path).toEqual([4, 2]);
  // Modified keys are not type-ahead.
  expect(press({ path: [0] }, "Tab").state.path).toEqual([0]);
});

it("clamps the menu inside the window", () => {
  expect(clampToWindow({ x: 10, y: 20 }, { w: 100, h: 50 }, { w: 800, h: 600 })).toEqual({ x: 10, y: 20 });
  expect(clampToWindow({ x: 790, y: 590 }, { w: 100, h: 50 }, { w: 800, h: 600 })).toEqual({ x: 700, y: 550 });
  expect(clampToWindow({ x: -5, y: -5 }, { w: 100, h: 50 }, { w: 800, h: 600 })).toEqual({ x: 0, y: 0 });
  // Larger than the window: pinned to the top left.
  expect(clampToWindow({ x: 50, y: 50 }, { w: 900, h: 700 }, { w: 800, h: 600 })).toEqual({ x: 0, y: 0 });
});

it("closes on outside pointer down, blur and scroll, not inside", () => {
  const win = new EventTarget();
  const doc = new EventTarget();
  const inside = {};
  const close = vi.fn();
  const off = attachDismiss(win, doc, (n) => n === inside, close);
  const down = (target: unknown) => {
    const e = new Event("pointerdown");
    Object.defineProperty(e, "target", { value: target });
    doc.dispatchEvent(e);
  };
  down(inside);
  expect(close).not.toHaveBeenCalled();
  down({});
  expect(close).toHaveBeenCalledTimes(1);
  win.dispatchEvent(new Event("blur"));
  expect(close).toHaveBeenCalledTimes(2);
  doc.dispatchEvent(new Event("scroll"));
  expect(close).toHaveBeenCalledTimes(3);
  off();
  win.dispatchEvent(new Event("blur"));
  expect(close).toHaveBeenCalledTimes(3);
});
