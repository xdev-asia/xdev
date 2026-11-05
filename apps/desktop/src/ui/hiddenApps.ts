import { useEffect, useSyncExternalStore } from "react";
import { resolveApp, type AppId } from "@/shell/apps";

// One copy for the window: `applyAppearance` stores the setting, the activity bar reads it.

const NONE: readonly string[] = [];

let current: readonly string[] = NONE;
const listeners = new Set<() => void>();

export function getHiddenApps(): readonly string[] {
  return current;
}

/** Stores `next` and tells every reader, once per real change. */
export function setHiddenApps(next: readonly string[]): void {
  if (current.length === next.length && current.every((id, i) => id === next[i])) return;
  current = [...next];
  for (const l of [...listeners]) l();
}

export function subscribeHiddenApps(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useHiddenApps(): readonly string[] {
  return useSyncExternalStore(subscribeHiddenApps, getHiddenApps, getHiddenApps);
}

/** Moves to the first visible app when the open one gets hidden. */
export function useVisibleApp(app: AppId, hidden: readonly string[], setApp: (next: AppId) => void): void {
  useEffect(() => {
    const next = resolveApp(app, hidden);
    if (next !== app) setApp(next);
  }, [app, hidden, setApp]);
}

/** Tests only. */
export function resetHiddenAppsForTests(): void {
  current = NONE;
  listeners.clear();
}
