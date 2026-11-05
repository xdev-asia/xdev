import { copyText } from "@/ui/clipboard";
import { pasteClipboard, type PasteResult } from "./clipboardPaste";
import type { ShellKind } from "./pathPaste";
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
  modes: { bracketedPasteMode: boolean };
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
  /** The clipboard image as a saved PNG path; absent: images are not pasted. */
  saveImage?(): Promise<string | null>;
  /** The quoting kind of the running program; unknown when absent. */
  shell?(): ShellKind;
  /** How a paste ended, for the toast. */
  pasted?(result: PasteResult): void;
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
      const result = await pasteClipboard({
        readText: async () => (await navigator.clipboard?.readText()) ?? "",
        saveImage: async () => (await deps.saveImage?.()) ?? null,
        // Read again: the view may have gone while the clipboard answered.
        pasteText: (text) => deps.term()?.paste(text),
        writeRaw: async (data) => {
          const client = deps.client();
          if (!client) throw new Error("no pty");
          await client.input(data);
        },
        shell: () => deps.shell?.() ?? "unknown",
        bracketedMode: () => deps.term()?.modes.bracketedPasteMode ?? false,
      });
      deps.pasted?.(result);
    },
    selectAll: () => deps.term()?.selectAll(),
    clear: () => deps.term()?.clear(),
    reset() {
      const term = deps.term();
      if (!term) return;
      term.reset();
      // Same size again, forced: the program redraws into the cleared screen.
      void deps.client()?.resize(term.cols, term.rows, true).catch(() => {});
    },
    find: () => deps.find(),
    hasSelection: () => deps.term()?.hasSelection() ?? false,
    focus: () => deps.term()?.focus(),
    lines(max) {
      const buffer = deps.term()?.buffer.active;
      if (!buffer) return [];
      const out: string[] = [];
      for (let y = 0; y < buffer.length; y++) out.push(buffer.getLine(y)?.translateToString(true) ?? "");
      return lastLines(out, max);
    },
  };
}

export { copyText };

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
  const exit = info.exitCode === undefined ? "running" : info.exitCode === null ? "unknown" : String(info.exitCode);
  return [
    `Terminal: ${info.title} (${info.profile})`,
    info.branch ? `Worktree: ${info.path} (${info.branch})` : `Worktree: ${info.path}`,
    `Last exit code: ${exit}`,
    `--- last ${CONTEXT_LINES} lines ---`,
    ...lastLines(lines, CONTEXT_LINES),
  ].join("\n");
}

/** Copy Context of one terminal to the clipboard; false when the clipboard refuses. */
export function copyContext(handle: TerminalHandle, info: ContextInfo): Promise<boolean> {
  return copyText(terminalContext(info, handle.lines(CONTEXT_LINES)));
}

/** The last `max` lines once blank lines at the end are dropped. */
export function lastLines(lines: string[], max: number): string[] {
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  return lines.slice(Math.max(0, end - max), end);
}
