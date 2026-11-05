import { useSyncExternalStore } from "react";
import type { Tab } from "@/workspace/sessions";
import { advanceRuns, type RunClocks } from "./chipModel";

let clocks: RunClocks = new Map();
const listeners = new Set<() => void>();

/** Looks at `tabs` now; subscribers hear of it only when a clock started or stopped. */
export function noteRuns(tabs: readonly Pick<Tab, "id" | "agent" | "status">[], now: number = Date.now()): void {
  const next = advanceRuns(clocks, tabs, now);
  if (next === clocks) return;
  clocks = next;
  for (const cb of listeners) cb();
}

export function resetRuns(): void {
  clocks = new Map();
  for (const cb of listeners) cb();
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
const snapshot = () => clocks;

export function useRunClocks(): RunClocks {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
