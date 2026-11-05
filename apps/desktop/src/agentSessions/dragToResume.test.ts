import { describe, expect, it, vi } from "vitest";
import { DRAG_THRESHOLD, DragController, IDLE, inside, move, press, release } from "./dragToResume";

const zone = { left: 0, top: 0, right: 300, bottom: 60 };

describe("drag helpers", () => {
  it("a press becomes a drag only past the threshold", () => {
    const down = press("k", 100, 200);
    expect(move(down, 100 + DRAG_THRESHOLD - 1, 200)).toBe(down);
    expect(move(down, 100, 200 + DRAG_THRESHOLD)).toEqual({ phase: "dragging", key: "k" });
    expect(move(IDLE, 500, 500)).toBe(IDLE);
  });

  it("a release gives the key only from a drag and only over the zone", () => {
    const dragging = move(press("k", 100, 200), 100, 100);
    expect(release(dragging, 50, 30, zone)).toBe("k");
    expect(release(dragging, 50, 300, zone)).toBeNull();
    expect(release(dragging, 50, 30, null)).toBeNull();
    expect(release(press("k", 50, 30), 50, 30, zone)).toBeNull();
    expect(inside(zone, 300, 60)).toBe(true);
    expect(inside(zone, 301, 60)).toBe(false);
  });
});

describe("DragController", () => {
  const make = (rect: typeof zone | null = zone) => {
    const hooks = { zone: () => rect, dragging: vi.fn(), drop: vi.fn() };
    return { hooks, c: new DragController(hooks) };
  };

  it("a short move and release is a click: no zone, no drop", () => {
    const { c, hooks } = make();
    c.down("k", 100, 200);
    c.moved(102, 201);
    expect(c.up(50, 30)).toBe(false);
    expect(hooks.dragging).not.toHaveBeenCalled();
    expect(hooks.drop).not.toHaveBeenCalled();
  });

  it("a drag shows the zone, and a release over it drops the row", () => {
    const { c, hooks } = make();
    c.down("k", 100, 200);
    c.moved(100, 150);
    expect(hooks.dragging).toHaveBeenLastCalledWith("k");
    expect(c.up(50, 30)).toBe(true);
    expect(hooks.dragging).toHaveBeenLastCalledWith(null);
    expect(hooks.drop).toHaveBeenCalledWith("k");
  });

  it("a release outside the zone, or a cancel, drops nothing and hides the zone", () => {
    const { c, hooks } = make();
    c.down("k", 100, 200);
    c.moved(100, 150);
    expect(c.up(100, 400)).toBe(true);
    c.down("k", 100, 200);
    c.moved(100, 150);
    c.cancel();
    expect(hooks.dragging).toHaveBeenLastCalledWith(null);
    expect(c.up(50, 30)).toBe(false);
    expect(hooks.drop).not.toHaveBeenCalled();
  });
});
