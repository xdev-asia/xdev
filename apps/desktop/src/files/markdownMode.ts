import { useSyncExternalStore } from "react";

export type MarkdownMode = "source" | "preview";

const modes = new Map<string, MarkdownMode>();
const listeners = new Set<() => void>();
const key = (worktree: string, rel: string): string => `${worktree}\n${rel}`;

/** Which half of a Markdown file tab shows. Kept here so it survives the tab remounting. */
export const markdownMode = {
  get: (worktree: string, rel: string): MarkdownMode => modes.get(key(worktree, rel)) ?? "source",
  set(worktree: string, rel: string, mode: MarkdownMode): void {
    modes.set(key(worktree, rel), mode);
    listeners.forEach((fn) => fn());
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
  reset(): void {
    modes.clear();
    listeners.forEach((fn) => fn());
  },
};

export function useMarkdownMode(worktree: string, rel: string): MarkdownMode {
  return useSyncExternalStore(markdownMode.subscribe, () => markdownMode.get(worktree, rel));
}
