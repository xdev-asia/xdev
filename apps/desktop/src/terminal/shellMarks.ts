import { useSyncExternalStore } from "react";

/**
 * What a shell with xDev's shell integration reports through OSC 133: where each prompt starts
 * (A), where the typed command starts (B), when it runs (C) and how it ended (D;code).
 */
export interface ShellMarks {
  /** The exit code of the last command that finished; null before one has, or when the shell gave none. */
  exitCode: number | null;
  /** True between a command's start (C) and its end (D). */
  running: boolean;
  /** How many prompts the buffer held at the last prompt. */
  prompts: number;
}

export type Osc133 =
  | { kind: "promptStart" }
  | { kind: "commandStart" }
  | { kind: "commandRun" }
  | { kind: "commandEnd"; exitCode: number | null };

/** One OSC 133 payload (`A`, `B`, `C`, `D;2`, with any `;key=value` after); null for anything else. */
export function parseOsc133(data: string): Osc133 | null {
  const [kind, arg] = data.split(";");
  switch (kind) {
    case "A":
      return { kind: "promptStart" };
    case "B":
      return { kind: "commandStart" };
    case "C":
      return { kind: "commandRun" };
    case "D":
      return { kind: "commandEnd", exitCode: arg !== undefined && /^-?\d{1,10}$/.test(arg) ? Number(arg) : null };
    default:
      return null;
  }
}

/**
 * The buffer line to scroll to for the prompt before (`-1`) or after (`1`) the top of the view;
 * undefined when there is none that way. `lines` is in buffer order.
 */
export function targetPromptLine(lines: readonly number[], viewportY: number, dir: -1 | 1): number | undefined {
  if (dir < 0) {
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i] < viewportY) return lines[i];
    return undefined;
  }
  return lines.find((l) => l > viewportY);
}

const EMPTY: ShellMarks = { exitCode: null, running: false, prompts: 0 };
/** Prompts kept per terminal; older ones are dropped first. */
export const MAX_PROMPTS = 2000;

interface Entry {
  marks: ShellMarks;
  lines(): number[];
}
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** The marks of one terminal, by pty id. */
export function getShellMarks(id: string): ShellMarks {
  return entries.get(id)?.marks ?? EMPTY;
}

/** The buffer lines of the prompts of one terminal, oldest first. */
export function promptLines(id: string): number[] {
  return entries.get(id)?.lines() ?? [];
}

export function subscribeShellMarks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The last exit code and prompt count of one terminal; re-renders when they change. */
export function useShellMarks(id: string): ShellMarks {
  return useSyncExternalStore(
    subscribeShellMarks,
    () => getShellMarks(id),
    () => EMPTY,
  );
}

interface Marker {
  readonly line: number;
  readonly isDisposed: boolean;
  dispose(): void;
}
interface MarkTerm {
  parser: { registerOscHandler(id: number, cb: (data: string) => boolean): { dispose(): void } };
  registerMarker(cursorYOffset?: number): Marker | undefined;
}

/**
 * Reads OSC 133 from one terminal: a marker at each prompt and the last exit code, kept under the
 * pty `id`. Returns the cleanup, which forgets the terminal.
 */
export function installShellMarks(term: MarkTerm, id: string): () => void {
  let markers: Marker[] = [];
  const live = () => {
    markers = markers.filter((m) => !m.isDisposed && m.line >= 0);
    return markers;
  };
  const entry: Entry = { marks: EMPTY, lines: () => live().map((m) => m.line) };
  entries.set(id, entry);
  const set = (change: Partial<ShellMarks>) => {
    const next = { ...entry.marks, ...change };
    if (next.exitCode === entry.marks.exitCode && next.running === entry.marks.running && next.prompts === entry.marks.prompts) return;
    entry.marks = next;
    if (entries.get(id) === entry) emit();
  };

  const handler = term.parser.registerOscHandler(133, (data) => {
    const mark = parseOsc133(data);
    if (!mark) return true;
    switch (mark.kind) {
      case "promptStart": {
        const now = live();
        const marker = term.registerMarker(0);
        // A redrawn prompt on the same line keeps one marker.
        if (marker && now.length > 0 && now[now.length - 1].line === marker.line) now.pop()?.dispose();
        if (marker) now.push(marker);
        while (now.length > MAX_PROMPTS) now.shift()?.dispose();
        set({ running: false, prompts: now.length });
        break;
      }
      case "commandRun":
        set({ running: true });
        break;
      case "commandEnd":
        set({ running: false, exitCode: mark.exitCode });
        break;
      case "commandStart":
        break;
    }
    return true;
  });

  return () => {
    handler.dispose();
    for (const m of markers) m.dispose();
    markers = [];
    if (entries.get(id) === entry) {
      entries.delete(id);
      emit();
    }
  };
}
