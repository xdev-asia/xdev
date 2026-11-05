import type { DropZone } from "./sessions";

/** How far the pointer must move before a press on a tab becomes a drag, so a click still selects. */
export const DRAG_THRESHOLD_PX = 4;

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Whether the pointer moved far enough from where it went down to start a drag. */
export function pastThreshold(from: { x: number; y: number }, x: number, y: number, px = DRAG_THRESHOLD_PX): boolean {
  return Math.hypot(x - from.x, y - from.y) > px;
}

/**
 * The drop zone of a pane body under the point: the outer quarter on the left or right (full height),
 * or on the top or bottom (between those). The middle is no zone. Null outside the box.
 */
export function zoneFor(box: Box, x: number, y: number): DropZone | null {
  const fx = (x - box.left) / box.width;
  const fy = (y - box.top) / box.height;
  if (!(fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1)) return null;
  if (fx < 0.25) return "left";
  if (fx > 0.75) return "right";
  if (fy < 0.25) return "top";
  if (fy > 0.75) return "bottom";
  return null;
}

/** Where a dragged tab lands in a strip: before or after the tab under `x`, or null with no tabs. */
export function insertAt(boxes: readonly { id: string; left: number; width: number }[], x: number): { id: string; after: boolean } | null {
  if (!boxes.length) return null;
  const hit = boxes.find((b) => x < b.left + b.width) ?? boxes[boxes.length - 1];
  return { id: hit.id, after: x >= hit.left + hit.width / 2 };
}

/** The tab id a drop before/after `mark` lands in front of; null means the end of the strip. */
export function beforeOf(ids: readonly string[], mark: { id: string; after: boolean }): string | null {
  return mark.after ? (ids[ids.indexOf(mark.id) + 1] ?? null) : mark.id;
}
