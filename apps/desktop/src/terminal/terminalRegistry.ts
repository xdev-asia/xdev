import type { TerminalHandle } from "./Terminal";

/** The live terminal handle of each tab, so the palette can act on the focused terminal. */
const handles = new Map<string, TerminalHandle>();

/** Records (or, with null, forgets) the handle of a tab's terminal. */
export function registerTerminal(id: string, handle: TerminalHandle | null): void {
  if (handle) handles.set(id, handle);
  else handles.delete(id);
}

export function terminalOf(id: string): TerminalHandle | null {
  return handles.get(id) ?? null;
}
