import { ZOOM_STEP, stepZoom } from "@xdev-asia/ui";
import { findMatches } from "./previewFind";

/** A match of the query in one text item of one page (both 0-based). */
export interface PageMatch {
  page: number;
  item: number;
  start: number;
  end: number;
}

/** Case-insensitive, non-overlapping matches in each item of each page, in document order. A match across two items is not found. */
export function pageMatches(pages: readonly (readonly string[])[], query: string): PageMatch[] {
  return pages.flatMap((items, page) => findMatches(items, query).map((m) => ({ page, item: m.node, start: m.start, end: m.end })));
}

/** The page of match `index`, and which match of that page it is; null when there is no such match. */
export function locateMatch(matches: readonly PageMatch[], index: number): { page: number; nth: number } | null {
  const m = matches[index];
  if (!m) return null;
  let nth = 0;
  for (let i = 0; i < index; i++) if (matches[i].page === m.page) nth++;
  return { page: m.page, nth };
}

/** A 1-based page number within 1..`count`. */
export function clampPage(page: number, count: number): number {
  return Math.min(Math.max(1, count), Math.max(1, page));
}

/** The page a typed value names, clamped; null when it is not a whole number. */
export function parsePageInput(raw: string, count: number): number | null {
  const v = raw.trim();
  return /^\d+$/.test(v) ? clampPage(Number(v), count) : null;
}

/** Top of each page when pages are stacked with `gap` between them. */
export function pageOffsets(heights: readonly number[], gap: number): number[] {
  const out: number[] = [];
  let y = 0;
  for (const h of heights) {
    out.push(y);
    y += h + gap;
  }
  return out;
}

/** The 0-based page that covers `y`; the last one past the end. */
export function pageAtScroll(offsets: readonly number[], y: number): number {
  let at = 0;
  for (let i = 0; i < offsets.length; i++) {
    if (offsets[i] <= y) at = i;
    else break;
  }
  return at;
}

/** Most pages kept drawn at once. */
export const MAX_RENDERED = 8;

/** The pages to draw: those in view plus `overscan` px around, at most `MAX_RENDERED`, those nearest the middle of the view winning. Ascending. */
export function pagesToRender(offsets: readonly number[], heights: readonly number[], scrollTop: number, viewH: number, overscan = viewH): number[] {
  const from = scrollTop - overscan;
  const to = scrollTop + viewH + overscan;
  const mid = scrollTop + viewH / 2;
  const inside: { page: number; dist: number }[] = [];
  for (let i = 0; i < offsets.length; i++) {
    const top = offsets[i];
    const bottom = top + heights[i];
    if (bottom <= from || top >= to) continue;
    inside.push({ page: i, dist: Math.abs((top + bottom) / 2 - mid) });
  }
  inside.sort((a, b) => a.dist - b.dist || a.page - b.page);
  return inside
    .slice(0, MAX_RENDERED)
    .map((p) => p.page)
    .sort((a, b) => a - b);
}

export const PDF_MIN_ZOOM = 0.25;
/** Lower than the library's limit, to bound canvas memory. */
export const PDF_MAX_ZOOM = 4;
/** CSS pixels per point. */
export const CSS_PER_PT = 96 / 72;

/** The scale at which a page `maxPageWidthPt` wide fills a box of `boxWidth` px with `padding` px on each side. */
export function fitWidthScale(maxPageWidthPt: number, boxWidth: number, padding: number): number {
  if (boxWidth <= 0 || maxPageWidthPt <= 0) return 1;
  const s = (boxWidth - 2 * padding) / (maxPageWidthPt * CSS_PER_PT);
  return Math.min(PDF_MAX_ZOOM, Math.max(PDF_MIN_ZOOM, s));
}

/** One zoom step in (`1`) or out (`-1`). */
export function zoomStep(scale: number, dir: 1 | -1): number {
  return stepZoom(scale, dir, ZOOM_STEP, PDF_MIN_ZOOM, PDF_MAX_ZOOM);
}

/** Most pixels of one canvas. */
export const MAX_CANVAS_PIXELS = 16_777_216;

/** The canvas pixels per CSS pixel: `dpr`, lowered when the page would pass `MAX_CANVAS_PIXELS`. */
export function canvasScale(cssW: number, cssH: number, dpr: number): number {
  const area = cssW * cssH;
  if (area <= 0) return dpr;
  return Math.min(dpr, Math.sqrt(MAX_CANVAS_PIXELS / area));
}

/** The error code a failed open shows as: "password", "invalid", an ApiError's own code, or "engine". */
export function pdfErrorCode(e: unknown): string {
  if (typeof e === "object" && e !== null) {
    const { name, code } = e as { name?: unknown; code?: unknown };
    if (name === "PasswordException") return "password";
    if (name === "InvalidPDFException") return "invalid";
    if (typeof code === "string") return code;
  }
  return "engine";
}
