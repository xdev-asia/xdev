import { describe, expect, it } from "vitest";
import {
  MAX_RENDERED,
  canvasScale,
  clampPage,
  fitWidthScale,
  locateMatch,
  pageAtScroll,
  pageMatches,
  pageOffsets,
  pagesToRender,
  parsePageInput,
  pdfErrorCode,
  zoomStep,
} from "./pdfModel";

describe("pageMatches", () => {
  it("finds matches per page and item, case-insensitively", () => {
    expect(pageMatches([["Hello world", ""], ["hello"]], "hello")).toEqual([
      { page: 0, item: 0, start: 0, end: 5 },
      { page: 1, item: 0, start: 0, end: 5 },
    ]);
  });
  it("gives none for an empty query", () => {
    expect(pageMatches([["a"]], "")).toEqual([]);
  });
  it("does not overlap", () => {
    expect(pageMatches([["aaaa"]], "aa")).toHaveLength(2);
  });
  it("misses a match across two items", () => {
    expect(pageMatches([["foo", "bar"]], "ob")).toHaveLength(0);
  });
});

describe("locateMatch", () => {
  it("counts the match within its page", () => {
    const m = pageMatches([["a a"], ["a"]], "a");
    expect(locateMatch(m, 1)).toEqual({ page: 0, nth: 1 });
    expect(locateMatch(m, 2)).toEqual({ page: 1, nth: 0 });
    expect(locateMatch(m, 3)).toBeNull();
    expect(locateMatch(m, -1)).toBeNull();
  });
});

describe("pages", () => {
  it("clamps a page number", () => {
    expect(clampPage(0, 5)).toBe(1);
    expect(clampPage(9, 5)).toBe(5);
    expect(clampPage(3, 5)).toBe(3);
  });
  it("parses a page input", () => {
    expect(parsePageInput(" 3 ", 5)).toBe(3);
    expect(parsePageInput("x", 5)).toBeNull();
    expect(parsePageInput("", 5)).toBeNull();
    expect(parsePageInput("2.5", 5)).toBeNull();
    expect(parsePageInput("99", 5)).toBe(5);
  });
  it("places pages one under another with a gap", () => {
    expect(pageOffsets([100, 200, 100], 8)).toEqual([0, 108, 316]);
  });
  it("finds the page at a scroll position", () => {
    const offsets = [0, 108, 316];
    expect(pageAtScroll(offsets, 0)).toBe(0);
    expect(pageAtScroll(offsets, 150)).toBe(1);
    expect(pageAtScroll(offsets, 9999)).toBe(2);
    expect(pageAtScroll([], 5)).toBe(0);
  });
});

describe("pagesToRender", () => {
  const heights = Array.from({ length: 50 }, () => 100);
  const offsets = pageOffsets(heights, 0);
  it("gives the visible pages and one viewport around them", () => {
    expect(pagesToRender(offsets, heights, 1000, 200)).toEqual([8, 9, 10, 11, 12, 13]);
  });
  it("never gives more than the cap, keeping those nearest the middle", () => {
    const got = pagesToRender(offsets, heights, 1000, 1000);
    expect(got).toHaveLength(MAX_RENDERED);
    expect(got).toContain(15);
    expect(got).not.toContain(0);
  });
  it("starts at the first page", () => {
    expect(pagesToRender(offsets, heights, 0, 100)[0]).toBe(0);
  });
});

describe("zoom", () => {
  it("fits a page into the box minus its padding", () => {
    expect(fitWidthScale(612, 360, 8)).toBeCloseTo(344 / (612 * (96 / 72)), 6);
    expect(fitWidthScale(612, 0, 8)).toBe(1);
    expect(fitWidthScale(10, 5000, 8)).toBe(4);
    expect(fitWidthScale(5000, 100, 8)).toBe(0.25);
  });
  it("steps by 1.25 within 0.25..4", () => {
    expect(zoomStep(1, 1)).toBe(1.25);
    expect(zoomStep(4, 1)).toBe(4);
    expect(zoomStep(0.25, -1)).toBe(0.25);
  });
  it("bounds a canvas to 16 Mpx and keeps the ratio for a small page", () => {
    const s = canvasScale(4000, 4000, 2);
    expect(4000 * s * 4000 * s).toBeLessThanOrEqual(16_777_216);
    expect(canvasScale(800, 1000, 2)).toBe(2);
  });
});

describe("pdfErrorCode", () => {
  it("maps the errors of the engine", () => {
    expect(pdfErrorCode({ name: "PasswordException" })).toBe("password");
    expect(pdfErrorCode({ name: "InvalidPDFException" })).toBe("invalid");
    expect(pdfErrorCode({ code: "too_large" })).toBe("too_large");
    expect(pdfErrorCode(new Error("x"))).toBe("engine");
    expect(pdfErrorCode(null)).toBe("engine");
  });
});
