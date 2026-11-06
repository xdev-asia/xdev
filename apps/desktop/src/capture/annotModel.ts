export type Tool = "arrow" | "box" | "text" | "blur";
export type ColorKey = "danger" | "warning" | "accent" | "fg";

export const TOOLS: readonly Tool[] = ["arrow", "box", "text", "blur"];
export const COLOR_KEYS: readonly ColorKey[] = ["danger", "warning", "accent", "fg"];

type Base = { id: string; color: ColorKey };
/** Geometry is in image pixels. */
export type Shape =
  | (Base & { tool: "arrow"; x1: number; y1: number; x2: number; y2: number })
  | (Base & { tool: "box"; x: number; y: number; w: number; h: number })
  | (Base & { tool: "text"; x: number; y: number; text: string; size: number })
  | (Base & { tool: "blur"; x: number; y: number; w: number; h: number });

export type State = {
  shapes: Shape[];
  undo: Shape[][];
  redo: Shape[][];
  tool: Tool;
  color: ColorKey;
  /** The shape being dragged, or the text being typed. */
  draft?: Shape;
  /** Where the drag began, in image pixels. */
  start?: { x: number; y: number };
  /** The text shape being typed: its id, and `draft` holds it. */
  editingText?: string;
  /** The shape Delete removes: the last one committed. */
  selected?: string;
};

export type Action =
  | { type: "pointerDown"; x: number; y: number; size?: number }
  | { type: "pointerMove"; x: number; y: number }
  | { type: "pointerUp"; x: number; y: number }
  | { type: "setTool"; tool: Tool }
  | { type: "setColor"; color: ColorKey }
  | { type: "commitText"; text: string }
  | { type: "cancelText" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "deleteSelected" };

/** A drag this short in both axes is a click, and makes no shape. */
export const MIN_DRAG = 4;
export const UNDO_LIMIT = 100;
export const DEFAULT_TEXT_SIZE = 24;

export const initialState: State = { shapes: [], undo: [], redo: [], tool: "arrow", color: "danger" };

let seq = 0;
const newId = () => `s${++seq}`;

function drag(tool: Exclude<Tool, "text">, id: string, color: ColorKey, from: { x: number; y: number }, to: { x: number; y: number }): Shape {
  if (tool === "arrow") return { id, color, tool, x1: from.x, y1: from.y, x2: to.x, y2: to.y };
  // A box or a blur dragged up or left has a negative size; store it as the same rectangle with a positive one.
  return { id, color, tool, x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y) };
}

/** Puts `shapes` in place as one undo step. */
function commit(state: State, shapes: Shape[], selected?: string): State {
  return {
    ...state,
    shapes,
    undo: [...state.undo, state.shapes].slice(-UNDO_LIMIT),
    redo: [],
    draft: undefined,
    start: undefined,
    editingText: undefined,
    selected,
  };
}

const idle = (state: State): State => ({ ...state, draft: undefined, start: undefined, editingText: undefined });

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "pointerDown": {
      const { x, y } = action;
      if (state.tool === "text") {
        const id = newId();
        const draft: Shape = { id, color: state.color, tool: "text", x, y, text: "", size: action.size ?? DEFAULT_TEXT_SIZE };
        return { ...state, draft, start: undefined, editingText: id };
      }
      const start = { x, y };
      return { ...idle(state), start, draft: drag(state.tool, newId(), state.color, start, start) };
    }
    case "pointerMove": {
      if (!state.draft || !state.start || state.draft.tool === "text") return state;
      return { ...state, draft: drag(state.draft.tool, state.draft.id, state.draft.color, state.start, action) };
    }
    case "pointerUp": {
      const { draft, start } = state;
      if (!draft || !start || draft.tool === "text") return state;
      if (Math.abs(action.x - start.x) <= MIN_DRAG && Math.abs(action.y - start.y) <= MIN_DRAG) return idle(state);
      return commit(state, [...state.shapes, drag(draft.tool, draft.id, draft.color, start, action)], draft.id);
    }
    case "setTool":
      return { ...idle(state), tool: action.tool };
    case "setColor":
      return { ...state, color: action.color };
    case "commitText": {
      const { draft } = state;
      const text = action.text.trim();
      if (!draft || draft.tool !== "text" || state.editingText !== draft.id) return state;
      if (text === "") return idle(state);
      return commit(state, [...state.shapes, { ...draft, text }], draft.id);
    }
    case "cancelText":
      return state.editingText ? idle(state) : state;
    case "undo": {
      const previous = state.undo[state.undo.length - 1];
      if (!previous) return state;
      return { ...idle(state), shapes: previous, undo: state.undo.slice(0, -1), redo: [...state.redo, state.shapes], selected: undefined };
    }
    case "redo": {
      const next = state.redo[state.redo.length - 1];
      if (!next) return state;
      return { ...idle(state), shapes: next, redo: state.redo.slice(0, -1), undo: [...state.undo, state.shapes].slice(-UNDO_LIMIT), selected: undefined };
    }
    case "deleteSelected": {
      if (!state.selected || !state.shapes.some((s) => s.id === state.selected)) return state;
      return commit(state, state.shapes.filter((s) => s.id !== state.selected));
    }
  }
}
