// What the floating workspace keeps across restarts (`<data_dir>/floating.json`). Rust stores it as
// opaque JSON and checks only `version` and size; this file owns the shape.

export const FLOATING_VERSION = 1;
/** A note body in UTF-8 bytes; the same cap as the phase 1 note. */
export const NOTE_MAX_BYTES = 256 * 1024;
export const NOTE_MAX_TABS = 8;

export type FloatingTabSnapshot =
  | { kind: "terminal"; id: string; n: number; cwd?: string; seq?: number }
  | { kind: "browser"; url: string; title?: string | null }
  | { kind: "note"; n: number; body: string };

export interface FloatingSnapshot {
  version: typeof FLOATING_VERSION;
  savedAt: string; // ISO
  active: number | null; // index into tabs
  tabs: FloatingTabSnapshot[];
}
