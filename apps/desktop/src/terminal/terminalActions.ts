import type { PtyClient } from "./ptyClient";
import type { TerminalHandle } from "./Terminal";

/** The lines Copy Context takes from the end of the buffer. */
export const CONTEXT_LINES = 200;

/** The part of an xterm the actions use; the tests hand in a stand-in. */
export interface XTermLike {
  cols: number;
  rows: number;
  getSelection(): string;
  hasSelection(): boolean;
  paste(text: string): void;
  selectAll(): void;
  clear(): void;
  reset(): void;
  focus(): void;
  buffer: { active: { length: number; getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined } };
}

/** What a handle reaches through: the live xterm and pty client (null before mount), and the find bar. */
export interface HandleDeps {
  term(): XTermLike | null;
  client(): PtyClient | null;
  find(): void;
}

/** A handle that reads its xterm on every call, so it stays valid across remounts. */
export function createTerminalHandle(deps: HandleDeps): TerminalHandle {
  return {
    async copy() {
      const term = deps.term();
      if (!term?.hasSelection()) return false;
      const text = term.getSelection();
      return text ? copyText(text) : false;
    },
    async paste() {
      if (!deps.term()) return;
      const text = await navigator.clipboard?.readText().catch(() => "");
      // Read again: the view may have gone while the clipboard answered.
      if (text) deps.term()?.paste(text);
    },
    selectAll: () => deps.term()?.selectAll(),
    clear: () => deps.term()?.clear(),
    reset: () => deps.term()?.reset(),
    find: () => deps.find(),
    hasSelection: () => deps.term()?.hasSelection() ?? false,
    focus: () => deps.term()?.focus(),
    lines: () => [],
  };
}

/** Writes text to the system clipboard (the writer copy-on-select uses); false when the webview refuses. */
export async function copyText(text: string): Promise<boolean> {
  if (!navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The header of Copy Context. `exitCode` undefined means the program still runs. */
export interface ContextInfo {
  title: string;
  profile: string;
  path: string;
  branch: string | null;
  exitCode?: number | null;
}

/** Copy Context text: header lines, then the buffer's last lines with blank tail lines dropped. */
export function terminalContext(info: ContextInfo, lines: string[]): string {
  // Contract stub: Lane B (B3).
  void info;
  void lines;
  return "";
}
