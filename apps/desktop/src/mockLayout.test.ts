import { describe, expect, it } from "vitest";
import { createMockLayout, LAYOUT_MAX } from "./mockLayout";
import { single } from "./workspace/paneTree";
import type { LayoutSnapshot } from "./workspace/layoutSnapshot";

const snap: LayoutSnapshot = {
  version: 1,
  savedAt: 5,
  worktrees: { "/w": { layout: single("t1"), tabs: { t1: { kind: "review" } } } },
};

describe("mock layout", () => {
  it("loads null until a snapshot is saved, then a copy of it", async () => {
    const api = createMockLayout();
    expect(await api.layoutLoad()).toBeNull();
    await api.layoutSave(snap);
    const loaded = await api.layoutLoad();
    expect(loaded).toEqual(snap);
    expect(loaded).not.toBe(snap);
  });

  it("refuses another version and an oversized snapshot, keeping the saved one", async () => {
    const api = createMockLayout(snap);
    await expect(api.layoutSave({ ...snap, version: 2 } as unknown as LayoutSnapshot)).rejects.toMatchObject({ code: "bad_arg" });
    const big = { ...snap, worktrees: { ["/" + "x".repeat(LAYOUT_MAX)]: snap.worktrees["/w"] } };
    await expect(api.layoutSave(big)).rejects.toEqual({ code: "too_large" });
    expect(await api.layoutLoad()).toEqual(snap);
  });
});
