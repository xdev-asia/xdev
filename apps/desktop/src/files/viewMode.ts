import { useSyncExternalStore } from "react";

/** Files whose table or notebook view was switched off for this session: they open in the code editor. */
const asText = new Set<string>();
const listeners = new Set<() => void>();
const key = (worktree: string, rel: string): string => `${worktree}\n${rel}`;

export const viewMode = {
  /** True when the file was opened as text. */
  isText: (worktree: string, rel: string): boolean => asText.has(key(worktree, rel)),
  set(worktree: string, rel: string, text: boolean): void {
    const k = key(worktree, rel);
    if (text === asText.has(k)) return;
    if (text) asText.add(k);
    else asText.delete(k);
    listeners.forEach((fn) => fn());
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
  reset(): void {
    asText.clear();
    listeners.forEach((fn) => fn());
  },
};

export function useOpenedAsText(worktree: string, rel: string): boolean {
  return useSyncExternalStore(viewMode.subscribe, () => viewMode.isText(worktree, rel), () => viewMode.isText(worktree, rel));
}
