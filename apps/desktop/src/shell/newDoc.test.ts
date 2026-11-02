import { describe, expect, it } from "vitest";
import { docFileName, newDocContent } from "./newDoc";

describe("docFileName", () => {
  it("keeps the title, including Vietnamese and spaces", () => {
    expect(docFileName("Ghi chú họp")).toBe("Ghi chú họp.md");
    expect(docFileName("  Plan  2027 ")).toBe("Plan 2027.md");
  });

  it("does not double the extension", () => {
    expect(docFileName("notes.md")).toBe("notes.md");
    expect(docFileName("Notes.MD")).toBe("Notes.md");
  });

  it("replaces characters a file name cannot hold", () => {
    expect(docFileName('a/b\\c:d*e?f"g<h>i|j')).toBe("a-b-c-d-e-f-g-h-i-j.md");
    expect(docFileName("..")).toBeNull();
    expect(docFileName("draft.")).toBe("draft.md");
  });

  it("returns null when nothing is left", () => {
    for (const title of ["", "   ", ".md", "..."]) expect(docFileName(title), title).toBeNull();
  });
});

describe("newDocContent", () => {
  it("starts with the title as a heading", () => {
    expect(newDocContent(" Ghi chú ")).toBe("# Ghi chú\n\n");
  });
});
