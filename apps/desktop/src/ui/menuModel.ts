import type { MenuItem } from "./ContextMenu";

/** The open path through the menu: one index per open level, the last one is the active item. */
export interface MenuState {
  path: number[];
}

/** What a key asks the host to do besides moving: run an item (and close), or close the menu. */
export type MenuEffect = { kind: "run"; item: MenuItem } | { kind: "close" };

const selectable = (item: MenuItem | undefined): boolean => !!item && item.kind !== "separator" && !item.disabled;

/** The items of the deepest open level, and the level above (for Left). */
export function levelItems(items: MenuItem[], path: number[], depth = path.length - 1): MenuItem[] {
  let level = items;
  for (let i = 0; i < depth; i++) level = level[path[i]]?.children ?? [];
  return level;
}

function step(level: MenuItem[], from: number, dir: 1 | -1): number {
  for (let n = 1; n <= level.length; n++) {
    const i = (((from + dir * n) % level.length) + level.length) % level.length;
    if (selectable(level[i])) return i;
  }
  return from;
}

/** The first enabled index of a level, or -1. */
export function firstEnabled(level: MenuItem[]): number {
  return level.findIndex(selectable);
}

/** A menu starts on its first enabled item; with none, nothing is active. */
export function initialMenu(items: MenuItem[]): MenuState {
  const first = firstEnabled(items);
  return { path: first < 0 ? [] : [first] };
}

/** One key press: the next state and what the host should do. Pure, so the menu logic needs no DOM. */
export function menuKey(
  state: MenuState,
  key: string,
  items: MenuItem[],
  t: (key: string) => string,
): { state: MenuState; effect?: MenuEffect } {
  const { path } = state;
  if (path.length === 0) return key === "Escape" ? { state, effect: { kind: "close" } } : { state };
  const depth = path.length - 1;
  const level = levelItems(items, path);
  const at = path[depth];
  const here = (index: number): MenuState => ({ path: [...path.slice(0, depth), index] });
  const active = level[at];

  switch (key) {
    case "ArrowDown":
      return { state: here(step(level, at, 1)) };
    case "ArrowUp":
      return { state: here(step(level, at, -1)) };
    case "Home":
      return { state: here(firstEnabled(level)) };
    case "End": {
      const last = level.length - 1 - [...level].reverse().findIndex(selectable);
      return { state: here(last) };
    }
    case "ArrowRight":
    case "Enter":
    case " ": {
      if (!selectable(active)) return { state };
      if (active.children?.length) {
        const first = firstEnabled(active.children);
        return { state: first < 0 ? state : { path: [...path, first] } };
      }
      if (key === "ArrowRight") return { state };
      return { state, effect: { kind: "run", item: active } };
    }
    case "ArrowLeft":
      return { state: depth > 0 ? { path: path.slice(0, -1) } : state };
    case "Escape":
      return depth > 0 ? { state: { path: path.slice(0, -1) } } : { state, effect: { kind: "close" } };
    default: {
      if (key.length !== 1) return { state };
      const letter = key.toLowerCase();
      for (let n = 1; n <= level.length; n++) {
        const i = (at + n) % level.length;
        if (selectable(level[i]) && t(level[i].labelKey).toLowerCase().startsWith(letter)) return { state: here(i) };
      }
      return { state };
    }
  }
}

/** Moves a menu of `size` so it stays inside the window; one that is too big sits at the top left. */
export function clampToWindow(
  at: { x: number; y: number },
  size: { w: number; h: number },
  win: { w: number; h: number },
): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(at.x, win.w - size.w)),
    y: Math.max(0, Math.min(at.y, win.h - size.h)),
  };
}

/**
 * Closes the menu on a pointer down outside it, on window blur and on scroll outside it.
 * Takes the targets as arguments so a test can hand in plain event targets. Returns the detach function.
 */
export function attachDismiss(
  win: EventTarget,
  doc: EventTarget,
  inside: (target: unknown) => boolean,
  close: () => void,
): () => void {
  const outside = (e: Event) => {
    if (!inside(e.target)) close();
  };
  const blur = () => close();
  doc.addEventListener("pointerdown", outside, true);
  doc.addEventListener("scroll", outside, true);
  win.addEventListener("blur", blur);
  return () => {
    doc.removeEventListener("pointerdown", outside, true);
    doc.removeEventListener("scroll", outside, true);
    win.removeEventListener("blur", blur);
  };
}
