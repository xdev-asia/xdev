import { useSyncExternalStore } from "react";

// "Replay tour" from the Help menu and the palette: a counter the tour watches.
let token = 0;
const listeners = new Set<() => void>();

export function replayTour(): void {
  token += 1;
  for (const l of [...listeners]) l();
}

export const subscribeReplay = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const replayCount = (): number => token;

/** Changes each time a replay is asked for. */
export const useReplayToken = (): number => useSyncExternalStore(subscribeReplay, replayCount, replayCount);
