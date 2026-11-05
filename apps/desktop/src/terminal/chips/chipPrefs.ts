import { useSyncExternalStore } from "react";

export type ChipKind = "quota" | "context" | "timer";
export const CHIP_KINDS: readonly ChipKind[] = ["quota", "context", "timer"];
export type ChipPrefs = Readonly<Record<ChipKind, boolean>>;

/** localStorage key of which header chips show. */
export const CHIP_PREFS_KEY = "xdev.paneChips.v1";

const ALL_ON: ChipPrefs = { quota: true, context: true, timer: true };

/** The stored choice; a chip not stored, or a value that is not a boolean, is on. */
export function parsePrefs(raw: string | null): ChipPrefs {
  if (!raw) return ALL_ON;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return ALL_ON;
    const o = v as Record<string, unknown>;
    return { quota: o.quota !== false, context: o.context !== false, timer: o.timer !== false };
  } catch {
    return ALL_ON;
  }
}

let current: ChipPrefs | null = null;
const listeners = new Set<() => void>();

function read(): ChipPrefs {
  if (current) return current;
  let raw: string | null = null;
  try {
    raw = typeof localStorage === "undefined" ? null : localStorage.getItem(CHIP_PREFS_KEY);
  } catch {
    // Storage may be blocked; the chips then stay on for this run.
  }
  current = parsePrefs(raw);
  return current;
}

export const chipPrefs = (): ChipPrefs => read();

export function setChip(kind: ChipKind, on: boolean): void {
  current = { ...read(), [kind]: on };
  try {
    localStorage.setItem(CHIP_PREFS_KEY, JSON.stringify(current));
  } catch {
    // Not saved; the choice holds until the app closes.
  }
  for (const cb of listeners) cb();
}

/** Test seam: forget what was read so the next read goes to storage again. */
export function resetChipPrefs(): void {
  current = null;
  for (const cb of listeners) cb();
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export function useChipPrefs(): ChipPrefs {
  return useSyncExternalStore(subscribe, read, read);
}
