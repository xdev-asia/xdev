import { describe, expect, it } from "vitest";
import { WORKTREE_DIR_HISTORY_MAX, pushDirHistory, worktreeDirOf } from "./worktreeDir";

describe("worktree folder history", () => {
  it("puts the newest first, once", () => {
    expect(pushDirHistory(["/a", "/b"], " /b ")).toEqual(["/b", "/a"]);
    expect(pushDirHistory([], "/a")).toEqual(["/a"]);
  });

  it("leaves the history for a blank or relative folder", () => {
    expect(pushDirHistory(["/a"], "")).toEqual(["/a"]);
    expect(pushDirHistory(["/a"], "rel/dir")).toEqual(["/a"]);
  });

  it("keeps at most five", () => {
    const full = Array.from({ length: WORKTREE_DIR_HISTORY_MAX + 3 }, (_, i) => `/d${i}`).reduce<string[]>(pushDirHistory, []);
    expect(full).toHaveLength(WORKTREE_DIR_HISTORY_MAX);
    expect(full[0]).toBe(`/d${WORKTREE_DIR_HISTORY_MAX + 2}`);
  });

  it("stores an absolute or empty folder only", () => {
    expect(worktreeDirOf("  ")).toBe("");
    expect(worktreeDirOf(" /trees ")).toBe("/trees");
    expect(worktreeDirOf("C:\\trees")).toBe("C:\\trees");
    expect(worktreeDirOf("trees")).toBe("bad");
  });
});
