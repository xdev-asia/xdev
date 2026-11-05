/** The pointer must move this far (px) from where it went down before a press becomes a drag. */
export const DRAG_THRESHOLD = 6;

export type Drag = { phase: "idle" } | { phase: "pressed"; key: string; x: number; y: number } | { phase: "dragging"; key: string };

export const IDLE: Drag = { phase: "idle" };

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A press on a row. */
export const press = (key: string, x: number, y: number): Drag => ({ phase: "pressed", key, x, y });

/** The pointer moved: a press that has gone past the threshold becomes a drag. */
export function move(drag: Drag, x: number, y: number): Drag {
  if (drag.phase !== "pressed") return drag;
  return Math.hypot(x - drag.x, y - drag.y) >= DRAG_THRESHOLD ? { phase: "dragging", key: drag.key } : drag;
}

export const inside = (rect: Rect | null, x: number, y: number): boolean =>
  rect !== null && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

/** The pointer went up: the key to resume when a drag ends over the drop zone, else null. Either way the drag is over. */
export function release(drag: Drag, x: number, y: number, zone: Rect | null): string | null {
  return drag.phase === "dragging" && inside(zone, x, y) ? drag.key : null;
}

export interface DragHooks {
  /** The drop zone's box on screen, or null while it is not shown. */
  zone(): Rect | null;
  /** A drag began (the key) or ended (null); the panel shows the zone while one runs. */
  dragging(key: string | null): void;
  /** A drag ended over the zone. */
  drop(key: string): void;
}

/** Pointer events in, hooks out: a press, a move past the threshold, and a release over the zone. */
export class DragController {
  private drag: Drag = IDLE;

  constructor(private readonly hooks: DragHooks) {}

  down(key: string, x: number, y: number): void {
    this.drag = press(key, x, y);
  }

  moved(x: number, y: number): void {
    const next = move(this.drag, x, y);
    if (next === this.drag) return;
    this.drag = next;
    if (next.phase === "dragging") this.hooks.dragging(next.key);
  }

  /** True when this release ended a drag, so the click that follows it is not a pick. */
  up(x: number, y: number): boolean {
    const was = this.drag.phase === "dragging";
    const key = release(this.drag, x, y, this.hooks.zone());
    this.drag = IDLE;
    if (was) this.hooks.dragging(null);
    if (key !== null) this.hooks.drop(key);
    return was;
  }

  cancel(): void {
    if (this.drag.phase === "dragging") this.hooks.dragging(null);
    this.drag = IDLE;
  }
}
