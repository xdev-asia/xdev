import { afterEach, describe, expect, it } from "vitest";
import {
  FLOATING_SELECTOR,
  OVERLAY_SELECTOR,
  PAGE_SELECTOR,
  coveredPages,
  hasOverlay,
  holdOverlay,
  overlaps,
  overlayOpen,
  overlayOver,
  pageShown,
  recheckOverlay,
  resetOverlayForTests,
  subscribeOverlay,
} from "./overlayWatch";

afterEach(() => resetOverlayForTests());

// No DOM in this suite: a root that answers the one query `hasOverlay` makes.
type FakeEl = { hiddenAncestor?: boolean; overlayAttr?: string | null };
const root = (els: FakeEl[]): ParentNode =>
  ({
    querySelectorAll(sel: string) {
      expect(sel).toBe(OVERLAY_SELECTOR);
      return els.map((e) => ({
        closest: (q: string) => (q === "[hidden]" && e.hiddenAncestor ? {} : null),
        getAttribute: (name: string) => (name === "data-overlay" ? (e.overlayAttr ?? null) : null),
      }));
    },
  }) as unknown as ParentNode;

describe("the overlay rule", () => {
  it.each([
    [{ visible: true, overlay: false, width: 640, height: 480 }, true],
    [{ visible: false, overlay: false, width: 640, height: 480 }, false],
    [{ visible: true, overlay: true, width: 640, height: 480 }, false],
    [{ visible: true, overlay: false, width: 0, height: 480 }, false],
    [{ visible: true, overlay: false, width: 640, height: 0.5 }, false],
    [{ visible: true, overlay: false, width: 1, height: 1 }, true],
  ])("%o shows: %s", (state, want) => {
    expect(pageShown(state)).toBe(want);
  });

  it("the selector names dialogs, menus and the explicit mark", () => {
    for (const part of ["dialog[open]", '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]', '[role="menu"]', "[data-overlay]"]) {
      expect(OVERLAY_SELECTOR).toContain(part);
    }
  });

  it("an overlay counts unless it sits in a hidden subtree or opts out", () => {
    expect(hasOverlay(root([]))).toBe(false);
    expect(hasOverlay(root([{}]))).toBe(true);
    expect(hasOverlay(root([{ hiddenAncestor: true }]))).toBe(false);
    expect(hasOverlay(root([{ overlayAttr: "false" }]))).toBe(false);
    expect(hasOverlay(root([{ hiddenAncestor: true }, { overlayAttr: "" }]))).toBe(true);
  });
});

// A page at x 100..500, y 100..400, and floating parts placed around it.
type Floating = { box: [number, number, number, number]; inPage?: boolean; hidden?: boolean; invisible?: boolean; holds?: string };
const rect = ([left, top, width, height]: [number, number, number, number]) => ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect;
const page = (tab: string, box: [number, number, number, number]) => ({
  tab,
  getAttribute: (name: string) => (name === "data-tab" ? tab : null),
  getBoundingClientRect: () => rect(box),
});
const floating = (f: Floating) => ({
  closest: (q: string) => (q === "[hidden]" && f.hidden) || (q === ".browser-page" && f.inPage) ? {} : null,
  getBoundingClientRect: () => rect(f.box),
  checkVisibility: () => !f.invisible,
  ...(f.holds === undefined ? {} : { contains: (p: { tab: string }) => p.tab === f.holds }),
});
const screen = (pages: ReturnType<typeof page>[], parts: Floating[]): ParentNode =>
  ({
    querySelectorAll(sel: string) {
      if (sel === PAGE_SELECTOR) return pages;
      expect(sel).toBe(FLOATING_SELECTOR);
      return parts.map(floating);
    },
  }) as unknown as ParentNode;

describe("floating parts", () => {
  it("the selector names status lines, tooltips and the toast stack", () => {
    for (const part of ['[role="status"]', '[role="tooltip"]', ".ws-toasts"]) expect(FLOATING_SELECTOR).toContain(part);
    expect(OVERLAY_SELECTOR).not.toContain("status");
  });

  it("boxes overlap only when they share some area", () => {
    const a = { left: 0, top: 0, right: 10, bottom: 10 };
    expect(overlaps(a, { left: 5, top: 5, right: 20, bottom: 20 })).toBe(true);
    expect(overlaps(a, { left: 10, top: 0, right: 20, bottom: 10 })).toBe(false);
    expect(overlaps(a, { left: 0, top: 11, right: 10, bottom: 20 })).toBe(false);
  });

  it("hide only the page they lie over", () => {
    const pages = [page("browser:a", [100, 100, 400, 300]), page("browser:b", [600, 100, 400, 300])];
    // A toast over the corner of page a.
    expect([...coveredPages(screen(pages, [{ box: [400, 350, 150, 60] }]))]).toEqual(["browser:a"]);
    // A status line in the footer, below both pages.
    expect(coveredPages(screen(pages, [{ box: [0, 700, 1200, 24] }])).size).toBe(0);
    // A toast across both.
    expect([...coveredPages(screen(pages, [{ box: [300, 150, 400, 40] }]))].sort()).toEqual(["browser:a", "browser:b"]);
  });

  it("skip the page's own note, hidden parts and screen-reader-only regions", () => {
    const pages = [page("browser:a", [100, 100, 400, 300])];
    const over: [number, number, number, number] = [200, 200, 100, 40];
    expect(coveredPages(screen(pages, [{ box: over, inPage: true }])).size).toBe(0);
    expect(coveredPages(screen(pages, [{ box: over, hidden: true }])).size).toBe(0);
    expect(coveredPages(screen(pages, [{ box: over, invisible: true }])).size).toBe(0);
    expect(coveredPages(screen(pages, [{ box: [200, 200, 1, 1] }])).size).toBe(0);
    expect(coveredPages(screen([], [{ box: over }])).size).toBe(0);
  });

  it("the selector names the floating workspace panel", () => {
    expect(FLOATING_SELECTOR).toContain(".floating-ws");
  });

  it("a page under the panel is covered, a page inside it is not", () => {
    const pages = [page("browser:a", [100, 100, 400, 300]), page("browser:b", [100, 100, 400, 300])];
    expect([...coveredPages(screen(pages, [{ box: [0, 0, 1000, 1000], holds: "none" }]))].sort()).toEqual(["browser:a", "browser:b"]);
    expect([...coveredPages(screen(pages, [{ box: [0, 0, 1000, 1000], holds: "browser:b" }]))]).toEqual(["browser:a"]);
  });

  it("a hidden panel covers nothing", () => {
    const pages = [page("browser:a", [100, 100, 400, 300])];
    expect(coveredPages(screen(pages, [{ box: [0, 0, 1000, 1000], hidden: true, holds: "none" }])).size).toBe(0);
  });

  it("a region panel is not an overlay", () => {
    const el = { closest: () => null, getAttribute: () => null, matches: (q: string) => q.includes('[role="region"]') };
    expect(OVERLAY_SELECTOR).not.toContain("region");
    expect(hasOverlay({ querySelectorAll: () => [] } as unknown as ParentNode)).toBe(false);
    expect(el.matches(OVERLAY_SELECTOR)).toBe(false);
  });

  it("a modal overlay still hides every page", () => {
    holdOverlay();
    expect(overlayOver("browser:a")).toBe(true);
    resetOverlayForTests();
    expect(overlayOver("browser:a")).toBe(false);
  });
});

describe("holdOverlay", () => {
  it("holds the pages hidden until every hold is released, once each", () => {
    let calls = 0;
    const off = subscribeOverlay(() => calls++);
    const a = holdOverlay();
    const b = holdOverlay();
    expect(overlayOpen()).toBe(true);
    a();
    a();
    expect(overlayOpen()).toBe(true);
    b();
    expect(overlayOpen()).toBe(false);
    expect(calls).toBe(2);
    off();
  });

  it("a recheck with no DOM and no hold reports none; the reset clears holds", () => {
    holdOverlay();
    expect(overlayOpen()).toBe(true);
    resetOverlayForTests();
    recheckOverlay();
    expect(overlayOpen()).toBe(false);
  });
});
