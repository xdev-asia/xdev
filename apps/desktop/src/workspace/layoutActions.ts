import { paneRects } from "./PaneView";
import { initialCanvas } from "./canvas/canvasModel";
import { applyPreset, type LayoutPreset } from "./layoutPresets";
import { leaves, type PaneLayout } from "./paneTree";

/** The part of `Sessions` the layout actions use. */
export interface LayoutStore {
  layout(worktree: string): PaneLayout | null;
  setLayout(worktree: string, next: PaneLayout | null): void;
  worktrees(): string[];
}

/** The layout in or out of canvas mode. The first time, the cards are laid out like the tree; later, they are where they were left. */
export function toggleCanvas(layout: PaneLayout): PaneLayout {
  if (layout.canvas) return { ...layout, canvas: { ...layout.canvas, on: !layout.canvas.on } };
  return { ...layout, canvas: initialCanvas(paneRects({ ...layout, expanded: null })) };
}

/** Applies the preset to one worktree; false when it has no layout. */
export function applyPresetTo(store: LayoutStore, worktree: string, preset: LayoutPreset): boolean {
  const layout = store.layout(worktree);
  if (!layout) return false;
  store.setLayout(worktree, applyPreset(layout, preset));
  return true;
}

/** Applies the preset to every worktree that has tabs; the number of worktrees it covered. */
export function applyPresetToAll(store: LayoutStore, preset: LayoutPreset): number {
  let n = 0;
  for (const wt of store.worktrees()) if (applyPresetTo(store, wt, preset)) n++;
  return n;
}

/** Worktrees that have a layout: the ones "all projects" covers. */
export function arrangeable(store: LayoutStore): string[] {
  return store.worktrees().filter((wt) => {
    const l = store.layout(wt);
    return l !== null && leaves(l).length > 0;
  });
}
