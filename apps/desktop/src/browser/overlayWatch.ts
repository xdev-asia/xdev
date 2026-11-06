import { useSyncExternalStore } from "react";

// A browser tab's page is a native webview drawn above the app's own page, so a menu, a palette or a
// dialog of the app would sit under it. While one is open every page is hidden. The app's overlays
// say what they are with a role (the library's Dialog, Menu, Popover and CommandPalette, the
// context menu); `[data-overlay]` marks one that has no such role, and `holdOverlay` covers anything
// the DOM cannot show (a native picker, say).
export const OVERLAY_SELECTOR = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], [data-overlay]';
const ATTRIBUTES = ["open", "role", "aria-modal", "hidden", "data-overlay"];

/** Whether an app overlay is on screen under `root`: one that matches and is not inside `[hidden]`. */
export function hasOverlay(root: ParentNode): boolean {
  for (const el of root.querySelectorAll(OVERLAY_SELECTOR)) {
    if (!el.closest("[hidden]") && el.getAttribute("data-overlay") !== "false") return true;
  }
  return false;
}

/** The rule: a page shows when its tab is on screen, no overlay is open and it has room. */
export function pageShown(state: { visible: boolean; overlay: boolean; width: number; height: number }): boolean {
  return state.visible && !state.overlay && state.width >= 1 && state.height >= 1;
}

let open = false;
let holds = 0;
let observer: MutationObserver | null = null;
const listeners = new Set<() => void>();

function set(next: boolean): void {
  if (next === open) return;
  open = next;
  for (const l of [...listeners]) l();
}

function check(): void {
  set(holds > 0 || (typeof document !== "undefined" && !!document.body && hasOverlay(document.body)));
}

// Terminal output adds many nodes; only those that could be an overlay, or a removal while one is
// open, are worth a look.
function relevant(records: MutationRecord[]): boolean {
  for (const r of records) {
    if (r.type === "attributes") return true;
    if (open && r.removedNodes.length > 0) return true;
    for (const n of r.addedNodes) {
      if (n instanceof Element && (n.matches(OVERLAY_SELECTOR) || n.querySelector(OVERLAY_SELECTOR))) return true;
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

/** Listens for overlays; the DOM is watched only while somebody listens (a browser tab is mounted). */
export function subscribeOverlay(listener: () => void): () => void {
  listeners.add(listener);
  start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

export function useAppOverlay(): boolean {
  return useSyncExternalStore(subscribeOverlay, overlayOpen, overlayOpen);
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
}
