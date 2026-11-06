// The terminal handle behind a DOM node: Terminal.tsx registers its host element on mount, so
// dictation can find the terminal the focus sits in without knowing the tab.

import type { TerminalHandle } from "./Terminal";

/** The part of a DOM node the lookup walks; the tests hand in a stand-in. */
export interface NodeLike {
  parentElement: NodeLike | null;
}

const handles = new WeakMap<NodeLike, TerminalHandle>();

export function registerTerminalHandle(host: NodeLike, handle: TerminalHandle): void {
  handles.set(host, handle);
}

/** Forgets `host`; with `handle`, only while that handle is still the registered one. */
export function unregisterTerminalHandle(host: NodeLike, handle?: TerminalHandle): void {
  if (handle && handles.get(host) !== handle) return;
  handles.delete(host);
}

/** The handle of the terminal `node` sits in, or null. */
export function terminalHandleAt(node: NodeLike | null): TerminalHandle | null {
  for (let at = node; at; at = at.parentElement) {
    const handle = handles.get(at);
    if (handle) return handle;
  }
  return null;
}
