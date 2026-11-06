import { afterEach, describe, expect, it } from "vitest";
import { leaves, paneOf, single, type PaneLayout } from "@/workspace/paneTree";
import { toSnapshot } from "@/workspace/layoutSnapshot";
import {
  BLANK,
  browserTab,
  browserTabEntries,
  closeBrowserTab,
  frontBrowserTab,
  frontInLayout,
  isBrowserTab,
  latestBrowserTab,
  notePage,
  openBrowserTab,
  placeBrowserTab,
  resetBrowserTabs,
  restoreBrowserTab,
  sendToBrowserTab,
  subscribeBrowserTabs,
} from "./browserTabs";

afterEach(() => resetBrowserTabs());

describe("the browser tab store", () => {
  it("opens a blank tab per worktree and closes it", () => {
    const a = openBrowserTab("/repo/a");
    const b = openBrowserTab("/repo/b", { url: "https://example.com/" });
    expect(isBrowserTab(a)).toBe(true);
    expect(isBrowserTab("term-1")).toBe(false);
    expect(browserTab(a)).toMatchObject({ worktree: "/repo/a", url: BLANK, title: null, nav: 0 });
    expect(browserTab(b)?.url).toBe("https://example.com/");
    closeBrowserTab(a);
    expect(browserTabEntries().map((e) => e.id)).toEqual([b]);
  });

  it("restores a saved tab without bringing it to the front", () => {
    const id = restoreBrowserTab("/repo/a", "http://localhost:3000/", "Dev server");
    expect(browserTab(id)).toMatchObject({ url: "http://localhost:3000/", title: "Dev server", seq: 0, nav: 0 });
    const empty = restoreBrowserTab("/repo/a", "");
    expect(browserTab(empty)?.url).toBe(BLANK);
  });

  it("a link sent to a tab loads it and asks for the front", () => {
    const id = openBrowserTab("/repo/a");
    const before = browserTab(id)!;
    sendToBrowserTab(id, "https://example.com/docs", true);
    const after = browserTab(id)!;
    expect(after.url).toBe("https://example.com/docs");
    expect(after.nav).toBe(before.nav + 1);
    expect(after.seq).toBeGreaterThan(before.seq);
    expect(after.keepFocus).toBe(true);
    frontBrowserTab(id);
    expect(browserTab(id)!.keepFocus).toBe(false);
  });

  it("the page's news emits only when something changed", () => {
    const id = openBrowserTab("/repo/a");
    let calls = 0;
    const off = subscribeBrowserTabs(() => calls++);
    notePage(id, { url: "https://a.example/", title: "A", loading: true });
    notePage(id, { url: "https://a.example/", title: "A", loading: true });
    notePage(id, { title: null });
    expect(calls).toBe(1);
    expect(browserTab(id)).toMatchObject({ url: "https://a.example/", title: "A", loading: true });
    notePage(id, { title: "" });
    expect(browserTab(id)!.title).toBeNull();
    off();
  });

  it("a link reuses the tab of its worktree asked for last", () => {
    const first = openBrowserTab("/repo/a");
    const second = openBrowserTab("/repo/a");
    openBrowserTab("/repo/b");
    expect(latestBrowserTab("/repo/a")?.id).toBe(second);
    frontBrowserTab(first);
    expect(latestBrowserTab("/repo/a")?.id).toBe(first);
    expect(latestBrowserTab("/repo/c")).toBeUndefined();
  });
});

describe("the layout", () => {
  const twoPanes = (): PaneLayout => placeBrowserTab(single("term-1"), { id: "browser:9", split: true, keepFocus: false });

  it("a new tab joins the focused pane, or opens a pane beside it", () => {
    expect(placeBrowserTab(null, { id: "browser:1", split: false, keepFocus: false })).toEqual(single("browser:1"));
    const joined = placeBrowserTab(single("term-1"), { id: "browser:1", split: false, keepFocus: false });
    expect(leaves(joined)[0]).toMatchObject({ tabs: ["term-1", "browser:1"], active: "browser:1" });
    const split = twoPanes();
    expect(leaves(split)).toHaveLength(2);
    expect(split.focused).toBe(paneOf(split, "browser:9"));
    expect(placeBrowserTab(split, { id: "browser:9", split: true, keepFocus: false })).toBe(split);
  });

  it("keepFocus leaves the focus on the pane that had it", () => {
    const base = single("term-1");
    const split = placeBrowserTab(base, { id: "browser:1", split: true, keepFocus: true });
    expect(leaves(split)).toHaveLength(2);
    expect(split.focused).toBe(base.focused);
  });

  it("brings a tab to the front, with or without the focus", () => {
    let l = twoPanes();
    const termPane = paneOf(l, "term-1")!;
    l = { ...l, focused: termPane };
    const kept = frontInLayout(l, "browser:9", true);
    expect(kept.focused).toBe(termPane);
    const moved = frontInLayout(l, "browser:9", false);
    expect(moved.focused).toBe(paneOf(l, "browser:9"));
    expect(frontInLayout(l, "browser:404", false)).toBe(l);
  });

  it("a saved layout keeps each tab's page and drops a tab without one", () => {
    const id = openBrowserTab("/repo/a", { url: "https://example.com/" });
    notePage(id, { title: "Example" });
    const layout = placeBrowserTab(single("browser:404"), { id, split: false, keepFocus: false });
    const snap = toSnapshot(layout, () => null, browserTab);
    const tabs = JSON.stringify(snap);
    expect(tabs).toContain('"kind":"browser"');
    expect(tabs).toContain('"url":"https://example.com/"');
    expect(tabs).toContain('"title":"Example"');
    expect(tabs).not.toContain("browser:404");
  });
});
