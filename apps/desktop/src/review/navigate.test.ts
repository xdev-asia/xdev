import { describe, expect, it } from "vitest";
import { nextChange } from "./navigate";

const files = [
  { path: "a", chunks: 2 },
  { path: "b", chunks: 0 },
  { path: "c", chunks: 1 },
];

describe("nextChange", () => {
  it("starts at the first or last change", () => {
    expect(nextChange(files, null, 1)).toEqual({ file: 0, chunk: 0 });
    expect(nextChange(files, null, -1)).toEqual({ file: 2, chunk: 0 });
  });

  it("moves within a file and across files, skipping empty ones", () => {
    expect(nextChange(files, { file: 0, chunk: 0 }, 1)).toEqual({ file: 0, chunk: 1 });
    expect(nextChange(files, { file: 0, chunk: 1 }, 1)).toEqual({ file: 2, chunk: 0 });
    expect(nextChange(files, { file: 2, chunk: 0 }, -1)).toEqual({ file: 0, chunk: 1 });
  });

  it("wraps both ways", () => {
    expect(nextChange(files, { file: 2, chunk: 0 }, 1)).toEqual({ file: 0, chunk: 0 });
    expect(nextChange(files, { file: 0, chunk: 0 }, -1)).toEqual({ file: 2, chunk: 0 });
  });

  it("starts from an empty file's place", () => {
    expect(nextChange(files, { file: 1, chunk: 0 }, 1)).toEqual({ file: 2, chunk: 0 });
    expect(nextChange(files, { file: 1, chunk: 0 }, -1)).toEqual({ file: 0, chunk: 1 });
  });

  it("returns null when nothing changed", () => {
    expect(nextChange([{ path: "a", chunks: 0 }], null, 1)).toBeNull();
    expect(nextChange([], null, -1)).toBeNull();
  });
});
