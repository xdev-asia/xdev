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

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, dflt: number): number => (typeof v === "number" && Number.isFinite(v) ? v : dflt);

/** `text` cut to at most `max` UTF-8 bytes, at a character boundary. */
export function cutUtf8(text: string, max: number): string {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= max) return text;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const size = enc.encode(ch).length;
    if (used + size > max) break;
    out += ch;
    used += size;
  }
  return out;
}

function parseTab(v: unknown): FloatingTabSnapshot | null {
  if (!isObj(v)) return null;
  if (v.kind === "terminal") {
    if (typeof v.id !== "string" || v.id === "") return null;
    const tab: FloatingTabSnapshot = { kind: "terminal", id: v.id, n: num(v.n, 1) };
    if (typeof v.cwd === "string" && v.cwd !== "") tab.cwd = v.cwd;
    if (typeof v.seq === "number" && Number.isFinite(v.seq) && v.seq >= 0) tab.seq = v.seq;
    return tab;
  }
  if (v.kind === "browser") {
    if (typeof v.url !== "string") return null;
    return { kind: "browser", url: v.url, title: typeof v.title === "string" ? v.title : null };
  }
  if (v.kind === "note") {
    if (typeof v.body !== "string") return null;
    return { kind: "note", n: num(v.n, 1), body: cutUtf8(v.body, NOTE_MAX_BYTES) };
  }
  return null;
}

/** Rows a hand-edited or broken file cannot use are dropped, never thrown. */
export function parseFloatingSnapshot(v: unknown): FloatingSnapshot | null {
  if (!isObj(v) || v.version !== FLOATING_VERSION || !Array.isArray(v.tabs)) return null;
  const tabs: FloatingTabSnapshot[] = [];
  let notes = 0;
  // `active` indexes the file's rows, so it is remapped to the rows kept.
  const kept = new Map<number, number>();
  v.tabs.forEach((row, i) => {
    const tab = parseTab(row);
    if (!tab) return;
    if (tab.kind === "note" && ++notes > NOTE_MAX_TABS) return;
    kept.set(i, tabs.length);
    tabs.push(tab);
  });
  const want = typeof v.active === "number" ? kept.get(v.active) : undefined;
  return {
    version: FLOATING_VERSION,
    savedAt: typeof v.savedAt === "string" ? v.savedAt : new Date(0).toISOString(),
    active: tabs.length === 0 ? null : (want ?? 0),
    tabs,
  };
}
