import { useSyncExternalStore } from "react";
import type { Api } from "@/api";
import { browserTab, closeBrowserTab, openBrowserTab } from "@/browser/browserTabs";
import { PtyClient } from "@/terminal/ptyClient";
import { FLOATING_VERSION, NOTE_MAX_BYTES, NOTE_MAX_TABS, type FloatingSnapshot, type FloatingTabSnapshot } from "./floatingSnapshot";

/** The worktree key of the panel's browser tabs. It is not a path, so no project lists them. */
export const FLOATING_WORKTREE = "xdev:floating";

export type FloatingKind = "terminal" | "browser" | "note";
export interface FloatingTab {
  id: string;
  kind: FloatingKind;
  n: number;
  /** A terminal's last folder (OSC 7), where a fresh restore starts it. */
  cwd?: string;
  /** A note's text. */
  body?: string;
}
export interface FloatingState {
  open: boolean;
  tabs: readonly FloatingTab[];
  active: string | null;
}

const EMPTY: FloatingState = { open: false, tabs: [], active: null };
let state: FloatingState = EMPTY;
// The display number of the next tab, per kind. The pty id is a UUID and never uses it.
const counters: Record<FloatingKind, number> = { terminal: 0, browser: 0, note: 0 };
// One client per terminal tab: restore attaches it before the panel mounts, and the snapshot reads its seq.
const clients = new Map<string, PtyClient>();
let apiRef: Api | null = null;
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

const newTermId = (): string => `floating-term-${crypto.randomUUID()}`;

/** The client of a terminal tab; made on the first ask (with `api`, or the last one given). */
export function clientOf(id: string, api?: Api): PtyClient {
  if (api) apiRef = api;
  let client = clients.get(id);
  if (!client) {
    if (!apiRef) throw new Error("floating: no api");
    client = new PtyClient(apiRef, id);
    clients.set(id, client);
  }
  return client;
}

/** Hands the store a client made elsewhere (a restore that attached it). */
export function registerFloatingClient(id: string, client: PtyClient): void {
  clients.set(id, client);
}

/** Drops a client without killing its pty (a fresh retry replaces it). */
export function forgetFloatingClient(id: string): void {
  clients.delete(id);
}

/** Adds a tab and makes it active; null when a note would pass the cap. */
export function addFloatingTab(kind: FloatingKind): string | null {
  if (kind === "note" && state.tabs.filter((t) => t.kind === "note").length >= NOTE_MAX_TABS) return null;
  const n = ++counters[kind];
  const id = kind === "terminal" ? newTermId() : kind === "browser" ? openBrowserTab(FLOATING_WORKTREE) : `floating-note-${crypto.randomUUID()}`;
  const tab: FloatingTab = kind === "note" ? { id, kind, n, body: "" } : { id, kind, n };
  set({ ...state, tabs: [...state.tabs, tab], active: id });
  return id;
}

export function openFloating(): void {
  if (state.tabs.length === 0) {
    const n = ++counters.terminal;
    const id = newTermId();
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
  if (tab.kind === "terminal") {
    // A client passed to `Terminal` is not killed on unmount, so closing the tab ends its pty here.
    const client = clients.get(id);
    clients.delete(id);
    void client?.dispose();
  }
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

/** Keeps a terminal's folder; the same value again tells nobody. */
export function setFloatingCwd(id: string, cwd: string): void {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab || tab.kind !== "terminal" || tab.cwd === cwd) return;
  set({ ...state, tabs: state.tabs.map((t) => (t === tab ? { ...t, cwd } : t)) });
}

/** Keeps a note's text; false (the old text kept) when it is over the cap in UTF-8. */
export function setNoteBody(id: string, text: string): boolean {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab || tab.kind !== "note") return false;
  if (new TextEncoder().encode(text).length > NOTE_MAX_BYTES) return false;
  if (tab.body === text) return true;
  set({ ...state, tabs: state.tabs.map((t) => (t === tab ? { ...t, body: text } : t)) });
  return true;
}

/** What is kept across a restart. Browser rows go by index: their ids are new on every run. */
export function snapshotFloating(): FloatingSnapshot {
  const tabs: FloatingTabSnapshot[] = state.tabs.map((t): FloatingTabSnapshot => {
    if (t.kind === "terminal") {
      const row: FloatingTabSnapshot = { kind: "terminal", id: t.id, n: t.n };
      if (t.cwd) row.cwd = t.cwd;
      const client = clients.get(t.id);
      if (client) row.seq = client.seq;
      return row;
    }
    if (t.kind === "browser") {
      const e = browserTab(t.id);
      return { kind: "browser", url: e?.url ?? "about:blank", title: e?.title ?? null };
    }
    return { kind: "note", n: t.n, body: t.body ?? "" };
  });
  const i = state.tabs.findIndex((t) => t.id === state.active);
  return { version: FLOATING_VERSION, savedAt: new Date().toISOString(), active: i < 0 ? null : i, tabs };
}

/**
 * Adds tabs a restore made, after any already open; the current active tab stays unless there is
 * none. The panel's open state is not touched. Counters go on from the highest restored number.
 */
export function applyRestored(tabs: readonly FloatingTab[], active: string | null): void {
  if (tabs.length === 0) return;
  for (const t of tabs) counters[t.kind] = Math.max(counters[t.kind], t.n);
  set({ ...state, tabs: [...state.tabs, ...tabs], active: state.active ?? active ?? tabs[0].id });
}

/** Whether the focus (by default the focused element of the page) is inside the panel. */
export function focusInFloating(active?: Element | null): boolean {
  const el = active === undefined ? (typeof document === "undefined" ? null : document.activeElement) : active;
  return !!el && !!el.closest(".floating-ws");
}

/** For tests. */
export function resetFloatingForTests(): void {
  state = EMPTY;
  counters.terminal = counters.browser = counters.note = 0;
  clients.clear();
  apiRef = null;
  listeners.clear();
}
