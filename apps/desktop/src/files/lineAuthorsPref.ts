import { useSyncExternalStore } from "react";

/** The part of `Storage` the preference uses. */
export type PrefStorage = Pick<Storage, "getItem" | "setItem">;

export const LINE_AUTHORS_KEY = "xdev.editor.lineAuthors";

/**
 * Whether the file editor shows the line-authors gutter, per user, on by default. Its own key: the
 * review's options object is written whole from the review's state and would drop it.
 */
export function createLineAuthorsPref(getStorage: () => PrefStorage | null) {
  const listeners = new Set<() => void>();
  let value: boolean | null = null;
  const load = (): boolean => {
    try {
      return getStorage()?.getItem(LINE_AUTHORS_KEY) !== "false";
    } catch {
      return true;
    }
  };
  return {
    get: (): boolean => (value ??= load()),
    set(on: boolean): void {
      value = on;
      try {
        getStorage()?.setItem(LINE_AUTHORS_KEY, on ? "true" : "false");
      } catch {
        // Storage is full or blocked: the choice still holds for this session.
      }
      listeners.forEach((fn) => fn());
    },
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}

function browserStorage(): PrefStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export const lineAuthorsPref = createLineAuthorsPref(browserStorage);

/** The preference, the same in every open editor. */
export function useLineAuthorsPref(): boolean {
  return useSyncExternalStore(
    lineAuthorsPref.subscribe,
    lineAuthorsPref.get,
    lineAuthorsPref.get,
  );
}
