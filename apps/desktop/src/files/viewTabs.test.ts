import { expect, it } from "vitest";
import { fileTabId, isFileTab } from "./fileTabs";
import { isPreviewTab, previewTabId } from "./previewTabs";
import { isViewTab, viewTabId, viewTabRel } from "./viewTabs";

it("an id round-trips, also with colons and slashes in the path", () => {
  for (const rel of ["a.ts", "src/b/c.md", "x:y.ts"]) {
    expect(viewTabRel(viewTabId(rel))).toBe(rel);
    expect(isViewTab(viewTabId(rel))).toBe(true);
  }
  expect(viewTabRel("file:a.ts")).toBeNull();
});

it("a view id clashes with no file, preview or terminal id", () => {
  const v = viewTabId("a.ts");
  expect(isFileTab(v) || isPreviewTab(v)).toBe(false);
  expect(isViewTab(fileTabId("a.ts"))).toBe(false);
  expect(isViewTab(previewTabId("a.ts"))).toBe(false);
  expect(isViewTab("t1")).toBe(false);
  expect(new Set([v, fileTabId("a.ts"), previewTabId("a.ts")]).size).toBe(3);
});
