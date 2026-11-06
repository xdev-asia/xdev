// When a downloaded update's card comes back after it was put away. Pure: the clock and the storage are passed in.

import { compareVersions } from "@/featureWall/featureWallModel";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The reminder delays offered in Settings, in days. */
export const REMIND_DAYS = [1, 3, 7] as const;
export const DEFAULT_REMIND_DAYS = 3;

/**
 * The version put away and what brings it back. `until` is the time of the reminder, or null for "skip this version":
 * only a newer version comes back then.
 */
export type NudgeState = { version: string; until: number | null };

export type Nudge = { now?: () => number; store?: NudgeStore | null };
export type NudgeStore = Pick<Storage, "getItem" | "setItem">;

export const NUDGE_KEY = "xdev.update.nudge";
export const REMIND_DAYS_KEY = "xdev.update.remindDays";

/** True when the card for `version` shows: nothing put away, a newer version, or the reminder time has come. */
export function cardVisible(version: string, state: NudgeState | null, now: number): boolean {
  if (!state) return true;
  if (compareVersions(version, state.version) > 0) return true;
  return state.until !== null && now >= state.until;
}

/** "Remind me later": the card returns after `days`. */
export function remindLater(version: string, now: number, days: number): NudgeState {
  return { version, until: now + days * DAY_MS };
}

/** "Skip this version": only a newer version brings the card back. */
export function skipVersion(version: string): NudgeState {
  return { version, until: null };
}

const defaultStore = (): NudgeStore | null => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};

export function loadNudge(store: NudgeStore | null = defaultStore()): NudgeState | null {
  try {
    const raw = store?.getItem(NUDGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<NudgeState> | null;
    if (!v || typeof v.version !== "string") return null;
    return { version: v.version, until: typeof v.until === "number" && Number.isFinite(v.until) ? v.until : null };
  } catch {
    return null;
  }
}

export function saveNudge(state: NudgeState, store: NudgeStore | null = defaultStore()): void {
  try {
    store?.setItem(NUDGE_KEY, JSON.stringify(state));
  } catch {
    // The card may come back sooner.
  }
}

/** The reminder delay in days; a missing or odd value is the default. */
export function loadRemindDays(store: NudgeStore | null = defaultStore()): number {
  try {
    const n = Number(store?.getItem(REMIND_DAYS_KEY));
    return (REMIND_DAYS as readonly number[]).includes(n) ? n : DEFAULT_REMIND_DAYS;
  } catch {
    return DEFAULT_REMIND_DAYS;
  }
}

export function saveRemindDays(days: number, store: NudgeStore | null = defaultStore()): void {
  try {
    store?.setItem(REMIND_DAYS_KEY, String(days));
  } catch {
    // The default stays.
  }
}
