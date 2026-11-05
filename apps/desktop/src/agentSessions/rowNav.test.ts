import { describe, expect, it } from "vitest";
import { nextRowIndex, type NavItem } from "./rowNav";

const items: NavItem[] = ["header", "row", "row", "header", "row", "header"];

describe("nextRowIndex", () => {
  it("moves down and up, skipping headers", () => {
    expect(nextRowIndex(items, 1, "ArrowDown")).toBe(2);
    expect(nextRowIndex(items, 2, "ArrowDown")).toBe(4);
    expect(nextRowIndex(items, 4, "ArrowUp")).toBe(2);
  });

  it("does not wrap at either end", () => {
    expect(nextRowIndex(items, 4, "ArrowDown")).toBe(4);
    expect(nextRowIndex(items, 1, "ArrowUp")).toBe(1);
  });

  it("jumps to the first and last row", () => {
    expect(nextRowIndex(items, 2, "Home")).toBe(1);
    expect(nextRowIndex(items, 2, "End")).toBe(4);
  });

  it("starts from an end when no row has the focus", () => {
    expect(nextRowIndex(items, -1, "ArrowDown")).toBe(1);
    expect(nextRowIndex(items, -1, "ArrowUp")).toBe(4);
  });

  it("has no index without rows", () => {
    expect(nextRowIndex(["header"], -1, "ArrowDown")).toBe(-1);
    expect(nextRowIndex([], 0, "Home")).toBe(-1);
  });
});
