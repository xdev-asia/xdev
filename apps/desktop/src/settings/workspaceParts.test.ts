import { expect, it } from "vitest";
import { moveApp, moveFromKey } from "./workspaceParts";

const ORDER = ["docs", "changes", "tasks"] as const;
const key = (k: string, extra: object = {}) => ({ key: k, altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, ...extra });

it("moves a part one place and keeps the others in order", () => {
  expect(moveApp(ORDER, "tasks", -1)).toEqual(["docs", "tasks", "changes"]);
  expect(moveApp(ORDER, "docs", 1)).toEqual(["changes", "docs", "tasks"]);
});

it("returns the same list when a part cannot move", () => {
  expect(moveApp(ORDER, "docs", -1)).toBe(ORDER);
  expect(moveApp(ORDER, "tasks", 1)).toBe(ORDER);
  expect(moveApp(ORDER, "kit", 1)).toBe(ORDER);
});

it("asks for a move only on Alt+ArrowUp or Alt+ArrowDown", () => {
  expect(moveFromKey(key("ArrowUp"))).toBe(-1);
  expect(moveFromKey(key("ArrowDown"))).toBe(1);
  expect(moveFromKey(key("ArrowDown", { altKey: false }))).toBeNull();
  expect(moveFromKey(key("ArrowDown", { ctrlKey: true }))).toBeNull();
  expect(moveFromKey(key("ArrowLeft"))).toBeNull();
});
