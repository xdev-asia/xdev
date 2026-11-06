import { describe, expect, it } from "vitest";
import { UNDO_LIMIT, initialState, reducer, type Action, type State, type Tool } from "./annotModel";

const run = (actions: Action[], from: State = initialState): State => actions.reduce(reducer, from);
const drag = (tool: Tool, a: [number, number], b: [number, number], from: State = initialState): State =>
  run(
    [
      { type: "setTool", tool },
      { type: "pointerDown", x: a[0], y: a[1] },
      { type: "pointerMove", x: b[0], y: b[1] },
      { type: "pointerUp", x: b[0], y: b[1] },
    ],
    from,
  );

describe("annotModel", () => {
  it("an arrow keeps its two ends", () => {
    const s = drag("arrow", [10, 20], [110, 90]);
    expect(s.shapes).toMatchObject([{ tool: "arrow", color: "danger", x1: 10, y1: 20, x2: 110, y2: 90 }]);
  });

  it("a box dragged up and left is the same rectangle with a positive size", () => {
    const s = drag("box", [100, 80], [40, 30]);
    expect(s.shapes).toMatchObject([{ tool: "box", x: 40, y: 30, w: 60, h: 50 }]);
  });

  it("a blur is normalised like a box", () => {
    const s = drag("blur", [100, 30], [40, 80]);
    expect(s.shapes).toMatchObject([{ tool: "blur", x: 40, y: 30, w: 60, h: 50 }]);
  });

  it("the draft follows the pointer before the drag ends", () => {
    const s = run([{ type: "setTool", tool: "box" }, { type: "pointerDown", x: 5, y: 5 }, { type: "pointerMove", x: 25, y: 15 }]);
    expect(s.draft).toMatchObject({ tool: "box", x: 5, y: 5, w: 20, h: 10 });
    expect(s.shapes).toEqual([]);
  });

  it("a drag of 4 px or less in both axes makes no shape", () => {
    const s = drag("box", [10, 10], [14, 14]);
    expect(s.shapes).toEqual([]);
    expect(s.undo).toEqual([]);
    expect(s.draft).toBeUndefined();
  });

  it("a drag longer than 4 px in one axis is a shape", () => {
    expect(drag("arrow", [10, 10], [15, 10]).shapes).toHaveLength(1);
  });

  it("text: the click opens an editor, commit makes the shape, cancel makes none", () => {
    const open = run([{ type: "setTool", tool: "text" }, { type: "pointerDown", x: 30, y: 40, size: 20 }]);
    expect(open.editingText).toBeDefined();
    const done = reducer(open, { type: "commitText", text: "  here " });
    expect(done.shapes).toMatchObject([{ tool: "text", x: 30, y: 40, text: "here", size: 20 }]);
    expect(done.editingText).toBeUndefined();
    expect(done.undo).toHaveLength(1);

    const cancelled = reducer(open, { type: "cancelText" });
    expect(cancelled.shapes).toEqual([]);
    expect(cancelled.editingText).toBeUndefined();
    // A second commit after the cancel does nothing.
    expect(reducer(cancelled, { type: "commitText", text: "late" }).shapes).toEqual([]);
  });

  it("an empty note is not a shape", () => {
    const open = run([{ type: "setTool", tool: "text" }, { type: "pointerDown", x: 1, y: 1 }]);
    expect(reducer(open, { type: "commitText", text: "   " }).shapes).toEqual([]);
  });

  it("undo and redo walk the steps; a new shape clears redo", () => {
    let s = drag("box", [0, 0], [50, 50]);
    s = drag("arrow", [0, 0], [60, 60], s);
    s = drag("blur", [0, 0], [70, 70], s);
    expect(s.shapes.map((x) => x.tool)).toEqual(["box", "arrow", "blur"]);
    s = run([{ type: "undo" }, { type: "undo" }], s);
    expect(s.shapes.map((x) => x.tool)).toEqual(["box"]);
    s = reducer(s, { type: "redo" });
    expect(s.shapes.map((x) => x.tool)).toEqual(["box", "arrow"]);
    s = drag("box", [0, 0], [80, 80], s);
    expect(s.redo).toEqual([]);
    expect(reducer(s, { type: "redo" })).toBe(s);
  });

  it("undo and redo with nothing to do change nothing", () => {
    expect(reducer(initialState, { type: "undo" })).toBe(initialState);
    expect(reducer(initialState, { type: "redo" })).toBe(initialState);
  });

  it("undo is capped at 100 steps", () => {
    let s = initialState;
    for (let i = 0; i < UNDO_LIMIT + 5; i++) s = drag("box", [0, 0], [10 + i, 50], s);
    expect(s.shapes).toHaveLength(UNDO_LIMIT + 5);
    expect(s.undo).toHaveLength(UNDO_LIMIT);
    // The oldest five steps are gone: 100 undos leave five shapes.
    s = run(Array.from({ length: UNDO_LIMIT + 3 }, () => ({ type: "undo" }) as Action), s);
    expect(s.shapes).toHaveLength(5);
  });

  it("delete removes the last committed shape as one undo step", () => {
    let s = drag("box", [0, 0], [50, 50]);
    s = drag("arrow", [0, 0], [60, 60], s);
    s = reducer(s, { type: "deleteSelected" });
    expect(s.shapes.map((x) => x.tool)).toEqual(["box"]);
    expect(reducer(s, { type: "undo" }).shapes).toHaveLength(2);
    // Nothing selected after a delete.
    expect(reducer(s, { type: "deleteSelected" })).toBe(s);
  });

  it("colour and tool apply to the next shape; a tool change drops a draft", () => {
    let s = run([{ type: "setColor", color: "accent" }]);
    s = drag("box", [0, 0], [50, 50], s);
    expect(s.shapes[0].color).toBe("accent");
    s = run([{ type: "setTool", tool: "box" }, { type: "pointerDown", x: 1, y: 1 }, { type: "setTool", tool: "arrow" }], s);
    expect(s.draft).toBeUndefined();
  });
});
