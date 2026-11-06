// Which releases the wall shows and which the person has seen. Pure, so it tests without a DOM.

import type { Release } from "./releases";

/** The numbers of a version; a missing or odd part counts as 0 ("0.8" is 0.8.0, "1.2.3-beta.1" is 1.2.3). */
export function parseVersion(version: string): [number, number, number] {
  const parts = version.trim().replace(/^v/i, "").split(/[-+]/)[0]!.split(".");
  const num = (i: number): number => {
    const n = Number.parseInt(parts[i] ?? "0", 10);
    return Number.isFinite(n) ? n : 0;
  };
  return [num(0), num(1), num(2)];
}

/** Negative when `a` is older than `b`, 0 when equal, positive when newer. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

/** The releases up to the running version that have cards, newest first. A release for a later version is not shown yet. */
export function releasesFor(releases: readonly Release[], appVersion: string): Release[] {
  return releases.filter((r) => r.cards.length > 0 && compareVersions(r.version, appVersion) <= 0).sort((a, b) => compareVersions(b.version, a.version));
}

/** The releases with cards newer than the last version whose wall was seen (`seen` null: none seen). */
export function unseenReleases(releases: readonly Release[], appVersion: string, seen: string | null): Release[] {
  return releasesFor(releases, appVersion).filter((r) => seen === null || compareVersions(r.version, seen) > 0);
}

export type WallStart = "none" | "open" | "remember";

/**
 * What the start does with the wall. A first run (the wizard has the screen and nothing was stored) has nothing new to
 * show: the version is remembered. After an update the wall opens once for the cards the person has not seen.
 */
export function wallStart(input: { releases: readonly Release[]; appVersion: string; seen: string | null; firstRun: boolean }): WallStart {
  if (input.seen === null && input.firstRun) return "remember";
  return unseenReleases(input.releases, input.appVersion, input.seen).length > 0 ? "open" : "none";
}

// Storage. Injected so a test keeps its own copy.
export const WALL_SEEN_KEY = "xdev.whatsNew.seen";

type Store = Pick<Storage, "getItem" | "setItem">;

const defaultStore = (): Store | null => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};

/** The newest version whose wall was seen; null when none was or storage cannot be read. */
export function loadWallSeen(store: Store | null = defaultStore()): string | null {
  try {
    return store?.getItem(WALL_SEEN_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Keeps the version as seen; an older one never replaces a newer one. */
export function saveWallSeen(version: string, store: Store | null = defaultStore()): void {
  try {
    const current = loadWallSeen(store);
    if (current === null || compareVersions(version, current) > 0) store?.setItem(WALL_SEEN_KEY, version);
  } catch {
    // The wall may open once more after the next update.
  }
}
