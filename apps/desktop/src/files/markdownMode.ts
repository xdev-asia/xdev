import { useSyncExternalStore } from "react";

export type MarkdownMode = "source" | "preview";

/** The part of `Storage` the mode store uses. */
export interface ModeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const MODE_STORAGE_KEY = "xdev.markdownMode";
/** The last choice of this many files is kept; the oldest is dropped. */
export const MODE_CAP = 200;

const key = (worktree: string, rel: string): string => `${worktree}\n${rel}`;
const isMode = (v: unknown): v is MarkdownMode => v === "source" || v === "preview";

/** Reads the saved list, oldest first; anything unreadable gives an empty list. */
function load(storage: ModeStorage | null, cap: number): Array<[string, MarkdownMode]> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(MODE_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is [string, MarkdownMode] => Array.isArray(e) && typeof e[0] === "string" && isMode(e[1])).slice(-cap);
  } catch {
    return [];
  }
}

/** Which half of a Markdown file tab shows, per file. Remembered in the storage when it works. */
export function createMarkdownModeStore(getStorage: () => ModeStorage | null, cap: number = MODE_CAP) {
  let modes: Map<string, MarkdownMode> | null = null;
  const listeners = new Set<() => void>();
  const read = (): Map<string, MarkdownMode> => (modes ??= new Map(load(getStorage(), cap)));
  const save = (): void => {
    try {
      getStorage()?.setItem(MODE_STORAGE_KEY, JSON.stringify([...read()]));
    } catch {
      // Storage is full or blocked: the choice still holds for this session.
    }
  };
  const emit = (): void => listeners.forEach((fn) => fn());
  return {
    get: (worktree: string, rel: string): MarkdownMode => read().get(key(worktree, rel)) ?? "source",
    set(worktree: string, rel: string, mode: MarkdownMode): void {
      const map = read();
      const k = key(worktree, rel);
      map.delete(k);
      map.set(k, mode);
      while (map.size > cap) map.delete(map.keys().next().value as string);
      save();
      emit();
    },
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    reset(): void {
      modes = new Map();
      try {
        getStorage()?.removeItem(MODE_STORAGE_KEY);
      } catch {
        // Nothing saved is the goal anyway.
      }
      emit();
    },
  };
}

function browserStorage(): ModeStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export const markdownMode = createMarkdownModeStore(browserStorage);

export function useMarkdownMode(worktree: string, rel: string): MarkdownMode {
  return useSyncExternalStore(markdownMode.subscribe, () => markdownMode.get(worktree, rel));
}
