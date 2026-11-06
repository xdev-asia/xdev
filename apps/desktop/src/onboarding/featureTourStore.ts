import { useSyncExternalStore } from "react";
import { resetSeenTours } from "./featureTours";

// "Replay feature tours" from Help: forgets what was shown and tells the tours on screen to look again.
let token = 0;
const listeners = new Set<() => void>();

export function replayFeatureTours(): void {
  resetSeenTours();
  token += 1;
  for (const l of [...listeners]) l();
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const count = (): number => token;

/** Changes each time a replay is asked for. */
export const useFeatureTourToken = (): number => useSyncExternalStore(subscribe, count, count);
