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

// The activity bar order is held the same way: `applyAppearance` stores it, the bar reads it.

let currentOrder: readonly string[] = NONE;
const orderListeners = new Set<() => void>();

export function getAppOrder(): readonly string[] {
  return currentOrder;
}

/** Stores the app order (empty is the default order) and tells every reader, once per real change. */
export function setAppOrder(next: readonly string[]): void {
  if (currentOrder.length === next.length && currentOrder.every((id, i) => id === next[i])) return;
  currentOrder = [...next];
  for (const l of [...orderListeners]) l();
}

export function subscribeAppOrder(listener: () => void): () => void {
  orderListeners.add(listener);
  return () => void orderListeners.delete(listener);
}

export function useAppOrder(): readonly string[] {
  return useSyncExternalStore(subscribeAppOrder, getAppOrder, getAppOrder);
}

/** Moves to the first visible app when the open one gets hidden. */
export function useVisibleApp(app: AppId, hidden: readonly string[], setApp: (next: AppId) => void, order: readonly string[] = NONE): void {
  useEffect(() => {
    const next = resolveApp(app, hidden, order);
    if (next !== app) setApp(next);
  }, [app, hidden, order, setApp]);
}

/** Tests only. */
export function resetHiddenAppsForTests(): void {
  current = NONE;
  currentOrder = NONE;
  listeners.clear();
  orderListeners.clear();
}
