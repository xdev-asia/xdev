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
  // Contract stub: Lane B (B1, B4) fills these in.
  void deps;
  return {
    copy: async () => false,
    paste: async () => {},
    selectAll: () => {},
    clear: () => {},
    reset: () => {},
    find: () => {},
    hasSelection: () => false,
    focus: () => {},
    lines: () => [],
  };
}

/** Writes text to the system clipboard; false when the webview refuses. */
export async function copyText(text: string): Promise<boolean> {
  // Contract stub: Lane B (B3).
  void text;
  return false;
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
