import { afterEach, describe, expect, it } from "vitest";
import { OVERLAY_SELECTOR, hasOverlay, holdOverlay, overlayOpen, pageShown, recheckOverlay, resetOverlayForTests, subscribeOverlay } from "./overlayWatch";

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
