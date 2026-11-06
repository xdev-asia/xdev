import { useSyncExternalStore } from "react";

// A browser tab's page is a native webview drawn above the app's own page, so a menu, a palette or a
// dialog of the app would sit under it. While one is open every page is hidden. The app's overlays
// say what they are with a role (the library's Dialog, Menu, Popover and CommandPalette, the
// context menu); `[data-overlay]` marks one that has no such role, and `holdOverlay` covers anything
// the DOM cannot show (a native picker, say).
export const OVERLAY_SELECTOR = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], [data-overlay]';
// A toast, a tooltip or a status line floats without blocking the app, so it hides only the pages
// it lies over. One inside a page's body is the tab's own note and never counts. The floating
// workspace panel is one too; the pages inside it are not covered by it.
export const FLOATING_SELECTOR = '[role="status"], [role="tooltip"], .ws-toasts, .floating-ws';
/** A tab's page body, which the webview covers; `data-tab` holds the tab id. */
export const PAGE_SELECTOR = ".browser-page[data-tab]";
const ATTRIBUTES = ["open", "role", "aria-modal", "hidden", "data-overlay", "data-open"];

/** Whether an app overlay is on screen under `root`: one that matches and is not inside `[hidden]`. */
export function hasOverlay(root: ParentNode): boolean {
  for (const el of root.querySelectorAll(OVERLAY_SELECTOR)) {
    if (!el.closest("[hidden]") && el.getAttribute("data-overlay") !== "false") return true;
  }
  return false;
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Whether two boxes share some area; touching edges do not count. */
export function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

// Hidden by style, or no bigger than the 1 px box of a screen-reader-only live region.
function unseen(el: Element, box: DOMRect): boolean {
  if (box.width <= 1 || box.height <= 1) return true;
  const check = (el as Element & { checkVisibility?: (o: object) => boolean }).checkVisibility;
  return typeof check === "function" && !check.call(el, { visibilityProperty: true, opacityProperty: true });
}

/** The tabs under `root` whose page lies under a floating part that is on screen. */
export function coveredPages(root: ParentNode): Set<string> {
  const covered = new Set<string>();
  const pages: Array<{ tab: string; box: DOMRect; el: Element }> = [];
  for (const el of root.querySelectorAll(PAGE_SELECTOR)) {
    const tab = el.getAttribute("data-tab");
    if (tab) pages.push({ tab, box: el.getBoundingClientRect(), el });
  }
  if (pages.length === 0) return covered;
  for (const el of root.querySelectorAll(FLOATING_SELECTOR)) {
    if (el.closest("[hidden]") || el.closest(".browser-page")) continue;
    const box = el.getBoundingClientRect();
    if (unseen(el, box)) continue;
    for (const p of pages) {
      // A page inside the floating workspace is part of it and stays shown.
      if (typeof el.contains === "function" && el.contains(p.el)) continue;
      if (overlaps(box, p.box)) covered.add(p.tab);
    }
  }
  return covered;
}

/** The rule: a page shows when its tab is on screen, no overlay is open and it has room. */
export function pageShown(state: { visible: boolean; overlay: boolean; width: number; height: number }): boolean {
  return state.visible && !state.overlay && state.width >= 1 && state.height >= 1;
}

let open = false;
let covered: ReadonlySet<string> = new Set();
let holds = 0;
let observer: MutationObserver | null = null;
const listeners = new Set<() => void>();

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((x) => b.has(x));

function set(next: boolean, nextCovered: ReadonlySet<string>): void {
  if (next === open && sameSet(nextCovered, covered)) return;
  open = next;
  covered = nextCovered;
  for (const l of [...listeners]) l();
}

function check(): void {
  const body = typeof document !== "undefined" ? document.body : null;
  set(holds > 0 || (!!body && hasOverlay(body)), body ? coveredPages(body) : new Set());
}

const WATCHED = `${OVERLAY_SELECTOR}, ${FLOATING_SELECTOR}, ${PAGE_SELECTOR}`;

// Terminal output adds many nodes; only those that could be an overlay, or a removal while one is
// open, are worth a look.
function relevant(records: MutationRecord[]): boolean {
  for (const r of records) {
    if (r.type === "attributes") return true;
    if ((open || covered.size > 0) && r.removedNodes.length > 0) return true;
    for (const n of r.addedNodes) {
      // A toast joins the stack as a child of `.ws-toasts`.
      if (n instanceof Element && (n.matches(WATCHED) || n.querySelector(WATCHED) || n.parentElement?.closest(".ws-toasts"))) return true;
    }
  }
  return false;
}

function start(): void {
  if (observer || typeof MutationObserver === "undefined" || typeof document === "undefined" || !document.body) return;
  observer = new MutationObserver((records) => {
    if (relevant(records)) check();
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ATTRIBUTES });
  check();
}

function stop(): void {
  observer?.disconnect();
  observer = null;
}

export function overlayOpen(): boolean {
  return open;
}

/** Whether `tab`'s page must hide: an overlay is open, or a floating part lies over it. */
export function overlayOver(tab: string): boolean {
  return open || covered.has(tab);
}

/** Listens for overlays; the DOM is watched only while somebody listens (a browser tab is mounted). */
export function subscribeOverlay(listener: () => void): () => void {
  listeners.add(listener);
  start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

export function useAppOverlay(tab: string): boolean {
  const over = () => overlayOver(tab);
  return useSyncExternalStore(subscribeOverlay, over, over);
}

/** Hides the pages until the returned function runs, for an overlay the DOM does not show. */
export function holdOverlay(): () => void {
  holds += 1;
  check();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    check();
  };
}

/** Looks again now; for tests, which do not wait for the observer. */
export function recheckOverlay(): void {
  check();
}

/** Tests only. */
export function resetOverlayForTests(): void {
  stop();
  listeners.clear();
  holds = 0;
  open = false;
  covered = new Set();
}
