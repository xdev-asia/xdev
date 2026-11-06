import { useSyncExternalStore } from "react";
import { loadWallSeen, saveWallSeen, unseenReleases } from "./featureWallModel";
import { RELEASES, type FeatureTarget } from "./releases";

// One copy for the window: the Help menu opens the wall, the host shows it, the shell answers "Try it".
interface WallState {
  open: boolean;
  /** The running version, once read. */
  appVersion: string | null;
  /** The newest version whose wall was seen. */
  seen: string | null;
}

let state: WallState = { open: false, appVersion: null, seen: loadWallSeen() };
const listeners = new Set<() => void>();
const set = (next: Partial<WallState>): void => {
  state = { ...state, ...next };
  for (const l of [...listeners]) l();
};

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const read = (): WallState => state;

export const useWallState = (): WallState => useSyncExternalStore(subscribe, read, read);

export function setWallVersion(appVersion: string): void {
  set({ appVersion });
}

/** Opens the wall; what it shows counts as seen from now on. */
export function openFeatureWall(): void {
  if (state.appVersion !== null) {
    saveWallSeen(state.appVersion);
    set({ open: true, seen: loadWallSeen() });
  } else set({ open: true });
}

export function closeFeatureWall(): void {
  set({ open: false });
}

/** Remembers the running version without showing anything (a first run). */
export function rememberWallVersion(version: string): void {
  saveWallSeen(version);
  set({ seen: loadWallSeen() });
}

/** True while the Help menu shows a dot: there are cards the person has not seen. */
export function wallHasNew(s: WallState): boolean {
  return s.appVersion !== null && unseenReleases(RELEASES, s.appVersion, s.seen).length > 0;
}
export const useWallHasNew = (): boolean => wallHasNew(useWallState());

// "Try it": the shell listens and opens the page or panel.
const tryListeners = new Set<(target: FeatureTarget) => void>();
export function tryFeature(target: FeatureTarget): void {
  for (const l of [...tryListeners]) l(target);
}
export function onTryFeature(l: (target: FeatureTarget) => void): () => void {
  tryListeners.add(l);
  return () => void tryListeners.delete(l);
}

/** Tests only. */
export function resetWallForTests(): void {
  state = { open: false, appVersion: null, seen: null };
  listeners.clear();
  tryListeners.clear();
}
