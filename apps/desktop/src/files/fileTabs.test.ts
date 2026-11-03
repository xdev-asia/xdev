import { expect, it, vi } from "vitest";
import { FILE_TAB, fileTabId, fileTabRel, isFileTab } from "./fileTabs";
import { onOpenFile, openFile } from "./openFile";
import { clampEditorSettings, EDITOR_DEFAULTS } from "./editorDefaults";

it("names file tabs apart from terminals and the review tab", () => {
  expect(fileTabId("src/a.ts")).toBe(`${FILE_TAB}src/a.ts`);
  expect(isFileTab(fileTabId("a"))).toBe(true);
  expect(isFileTab("review:")).toBe(false);
  expect(isFileTab("t1")).toBe(false);
  expect(fileTabRel(fileTabId("a/b c.md"))).toBe("a/b c.md");
  expect(fileTabRel("t1")).toBeNull();
});

it("hands every open to the listeners until they stop", () => {
  const fn = vi.fn();
  const stop = onOpenFile(fn);
  openFile({ worktree: "/wt/a", rel: "src/a.ts", line: 3 });
  expect(fn).toHaveBeenCalledWith({ worktree: "/wt/a", rel: "src/a.ts", line: 3 });
  stop();
  openFile({ worktree: "/wt/a", rel: "b" });
  expect(fn).toHaveBeenCalledTimes(1);
});

it("clamps editor settings like Rust stores them", () => {
  expect(clampEditorSettings(EDITOR_DEFAULTS)).toEqual(EDITOR_DEFAULTS);
  const wild = clampEditorSettings({ ...EDITOR_DEFAULTS, autosaveMs: 5, fontSize: 99, tabSize: 0 });
  expect(wild).toMatchObject({ autosaveMs: 250, fontSize: 32, tabSize: 1 });
  expect(clampEditorSettings({ ...EDITOR_DEFAULTS, autosaveMs: 99999, tabSize: 2.6 })).toMatchObject({ autosaveMs: 10000, tabSize: 3 });
});
