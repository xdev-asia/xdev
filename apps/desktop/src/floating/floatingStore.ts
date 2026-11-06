import { useSyncExternalStore } from "react";
import { closeBrowserTab, openBrowserTab } from "@/browser/browserTabs";

/** The worktree key of the panel's browser tabs. It is not a path, so no project lists them. */
export const FLOATING_WORKTREE = "xdev:floating";

export type FloatingKind = "terminal" | "browser" | "note";
export interface FloatingTab {
  id: string;
  kind: FloatingKind;
  n: number;
}
export interface FloatingState {
  open: boolean;
  tabs: readonly FloatingTab[];
  active: string | null;
}

const EMPTY: FloatingState = { open: false, tabs: [], active: null };
let state: FloatingState = EMPTY;
let counter = 0;
const NOTE_ID = "floating-note";
const listeners = new Set<() => void>();

function set(next: FloatingState): void {
  if (next.open === state.open && next.active === state.active && next.tabs === state.tabs) return;
  state = next;
  for (const l of [...listeners]) l();
}

export function floatingState(): FloatingState {
  return state;
}

export function subscribeFloating(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useFloating(): FloatingState {
  return useSyncExternalStore(subscribeFloating, floatingState, floatingState);
}

/** Adds a tab and makes it active; the note tab is unique, so a second ask returns it. */
export function addFloatingTab(kind: FloatingKind): string {
  if (kind === "note") {
    const have = state.tabs.find((t) => t.kind === "note");
    if (have) {
      set({ ...state, active: have.id });
      return have.id;
    }
  }
  const n = ++counter;
  const id = kind === "terminal" ? `floating-term-${n}` : kind === "browser" ? openBrowserTab(FLOATING_WORKTREE) : NOTE_ID;
  set({ ...state, tabs: [...state.tabs, { id, kind, n }], active: id });
  return id;
}

export function openFloating(): void {
  if (state.tabs.length === 0) {
    const n = ++counter;
    const id = `floating-term-${n}`;
    set({ open: true, tabs: [{ id, kind: "terminal", n }], active: id });
    return;
  }
  set({ ...state, open: true });
}

export function closeFloating(): void {
  set({ ...state, open: false });
}

export function toggleFloating(): void {
  if (state.open) closeFloating();
  else openFloating();
}

export function selectFloatingTab(id: string): void {
  if (!state.tabs.some((t) => t.id === id)) return;
  set({ ...state, active: id });
}

export function closeFloatingTab(id: string): void {
  const i = state.tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const tab = state.tabs[i];
  if (tab.kind === "browser") closeBrowserTab(id);
  const tabs = state.tabs.filter((t) => t.id !== id);
  const active = state.active === id ? (tabs[i] ?? tabs[i - 1] ?? null)?.id ?? null : state.active;
  set({ ...state, tabs, active });
}

export function stepFloatingTab(by: 1 | -1): void {
  const { tabs, active } = state;
  if (tabs.length === 0) return;
  const i = tabs.findIndex((t) => t.id === active);
  const next = tabs[(i + by + tabs.length) % tabs.length];
  set({ ...state, active: next.id });
}

/** Whether the focus (by default the focused element of the page) is inside the panel. */
export function focusInFloating(active?: Element | null): boolean {
  const el = active === undefined ? (typeof document === "undefined" ? null : document.activeElement) : active;
  return !!el && !!el.closest(".floating-ws");
}

/** For tests. */
export function resetFloatingForTests(): void {
  state = EMPTY;
  counter = 0;
  listeners.clear();
}
