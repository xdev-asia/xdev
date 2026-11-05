import { expect, it } from "vitest";
import { fileTabId } from "./fileTabs";
import { isPreviewTab, previewTabId, previewTabRel } from "./previewTabs";

it("builds, recognises and reads a preview tab id", () => {
  expect(previewTabId("docs/a.md")).toBe("preview:docs/a.md");
  expect(isPreviewTab("preview:docs/a.md")).toBe(true);
  expect(previewTabRel("preview:docs/a.md")).toBe("docs/a.md");
});

it("is not a file, review or terminal tab", () => {
  for (const id of [fileTabId("a.md"), "review:", "t1", "7f3a"]) {
    expect(isPreviewTab(id)).toBe(false);
    expect(previewTabRel(id)).toBeNull();
  }
  expect(isPreviewTab(previewTabId("a.md"))).toBe(true);
  expect(fileTabId("a.md")).not.toBe(previewTabId("a.md"));
});
