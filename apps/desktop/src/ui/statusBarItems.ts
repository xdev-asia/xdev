import { useSyncExternalStore } from "react";
import type { StatusBarItems } from "@/api";

// One copy for the window: `applyAppearance` stores the setting, the footer reads it.

export const ALL_ITEMS: StatusBarItems = { branch: true, tokenUsage: true, agents: true, version: true, ports: true };

let current: StatusBarItems = ALL_ITEMS;
const listeners = new Set<() => void>();

export function getStatusBarItems(): StatusBarItems {
  return current;
}

/** Stores `next` and tells every reader, once per real change. */
export function setStatusBarItems(next: StatusBarItems): void {
  if (JSON.stringify(current) === JSON.stringify(next)) return;
  current = { ...next };
  for (const l of [...listeners]) l();
}

export function subscribeStatusBarItems(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useStatusBarItems(): StatusBarItems {
  return useSyncExternalStore(subscribeStatusBarItems, getStatusBarItems, getStatusBarItems);
}

/** Tests only. */
export function resetStatusBarItemsForTests(): void {
  current = ALL_ITEMS;
  listeners.clear();
}
