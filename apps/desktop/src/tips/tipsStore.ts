import { useSyncExternalStore } from "react";
import { loadTipsEnabled, saveTipsEnabled } from "./tipsModel";

// "Show feature tips": one copy for the window, written by Settings and by "Don't show tips".
let enabled = loadTipsEnabled();
const listeners = new Set<() => void>();

export function setTipsEnabled(value: boolean): void {
  saveTipsEnabled(value);
  if (value === enabled) return;
  enabled = value;
  for (const l of [...listeners]) l();
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const read = (): boolean => enabled;

export const useTipsEnabled = (): boolean => useSyncExternalStore(subscribe, read, read);

let shown = false;
/** One tip modal per launch: later opens (after a setting is turned back on) wait for the next start. */
export const tipShownThisRun = (): boolean => shown;
export const markTipShownThisRun = (): void => void (shown = true);

/** Tests only. */
export function resetTipsForTests(): void {
  enabled = true;
  shown = false;
  listeners.clear();
}
