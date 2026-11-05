import { useSyncExternalStore } from "react";
import type { TitlebarMode, UiSettings } from "@/api";

// One copy for the window: `applyAppearance` stores the setting, the shell reads it.

export interface TitlebarState {
  mode: TitlebarMode;
  showName: boolean;
}

const DEFAULT: TitlebarState = { mode: "native", showName: true };

let current: TitlebarState = DEFAULT;
const listeners = new Set<() => void>();

export function getTitlebar(): TitlebarState {
  return current;
}

/** Stores `next` and tells every reader, once per real change. */
export function setTitlebar(next: Partial<Pick<UiSettings, "titlebar" | "showTitlebarName">>): void {
  const state: TitlebarState = { mode: next.titlebar ?? DEFAULT.mode, showName: next.showTitlebarName ?? DEFAULT.showName };
  if (state.mode === current.mode && state.showName === current.showName) return;
  current = state;
  for (const l of [...listeners]) l();
}

export function subscribeTitlebar(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useTitlebar(): TitlebarState {
  return useSyncExternalStore(subscribeTitlebar, getTitlebar, getTitlebar);
}

/** Tests only. */
export function resetTitlebarForTests(): void {
  current = DEFAULT;
  listeners.clear();
}
