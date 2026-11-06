import { afterEach, describe, expect, it } from "vitest";
import { createMockApi } from "@/mockApi";
import { leaves } from "./paneTree";
import { Sessions, reorderTabs, stepBefore } from "./sessions";

const A = "/demo/wt/xdev-oak";

describe("reorderTabs", () => {
  it("moves a tab before another, or last", () => {
    expect(reorderTabs(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(reorderTabs(["a", "b", "c"], "a", null)).toEqual(["b", "c", "a"]);
    expect(reorderTabs(["a", "b", "c"], "a", "c")).toEqual(["b", "a", "c"]);
  });

  it("returns the same list for a no-op or an unknown id", () => {
    const tabs = ["a", "b", "c"];
    expect(reorderTabs(tabs, "b", "c")).toBe(tabs);
    expect(reorderTabs(tabs, "c", null)).toBe(tabs);
    expect(reorderTabs(tabs, "a", "a")).toBe(tabs);
    expect(reorderTabs(tabs, "x", "a")).toBe(tabs);
    expect(reorderTabs(tabs, "a", "x")).toBe(tabs);
  });
});

describe("stepBefore", () => {
  const tabs = ["a", "b", "c"];
  it("names the tab to go before, one place along", () => {
    expect(stepBefore(tabs, "b", -1)).toBe("a");
    expect(stepBefore(tabs, "a", 1)).toBe("c");
    expect(stepBefore(tabs, "b", 1)).toBeNull();
  });
  it("is undefined at an end or for an unknown tab", () => {
    expect(stepBefore(tabs, "a", -1)).toBeUndefined();
    expect(stepBefore(tabs, "c", 1)).toBeUndefined();
    expect(stepBefore(tabs, "x", 1)).toBeUndefined();
  });
});

describe("Sessions.reorderTab", () => {
  let s: Sessions | null = null;
  afterEach(() => {
    s?.dispose();
    s = null;
  });
  const strip = (sessions: Sessions) => {
    const leaf = leaves(sessions.layout(A)!)[0];
    return leaf.kind === "leaf" ? leaf.tabs : [];
  };

  it("moves a tab one place left or right with stepBefore, and keeps pinned tabs first", () => {
    s = new Sessions(createMockApi({}), () => 1000);
    const [a, b, c] = [s.open(A, "shell"), s.open(A, "shell"), s.open(A, "shell")];
    expect(strip(s)).toEqual([a.id, b.id, c.id]);
    s.reorderTab(c.id, stepBefore(strip(s), c.id, -1)!);
    expect(strip(s)).toEqual([a.id, c.id, b.id]);
    s.reorderTab(a.id, stepBefore(strip(s), a.id, 1)!);
    expect(strip(s)).toEqual([c.id, a.id, b.id]);
    s.setPinned(b.id, true);
    expect(strip(s)[0]).toBe(b.id);
    s.reorderTab(a.id, b.id);
    expect(strip(s)[0]).toBe(b.id);
  });
});
