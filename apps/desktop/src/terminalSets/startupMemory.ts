import type { SequenceStep } from "@/api";

// The startup sequence each tab was opened with, by tab id, so "Save as preset" and "Save current tabs
// as set" can offer what a running tab did. Lives as long as the window; a restored tab has none.
const memory = new Map<string, SequenceStep[]>();

export function rememberStartup(tabId: string, steps: readonly SequenceStep[]): void {
  if (steps.length === 0) memory.delete(tabId);
  else memory.set(tabId, structuredClone([...steps]));
}

export const startupOf = (tabId: string): readonly SequenceStep[] => memory.get(tabId) ?? [];

/** Tests only. */
export function resetStartupMemory(): void {
  memory.clear();
}
