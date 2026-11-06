import type { FileVersion } from "@/api";

/** Which version is picked, and whether the person is being asked to confirm its restore. */
export type Flow = { picked: FileVersion | null; confirming: boolean };
export type FlowAction = { type: "pick"; version: FileVersion } | { type: "ask" } | { type: "cancel" } | { type: "restored" };

export const START: Flow = { picked: null, confirming: false };

/** A restore is only ever reached through `ask`, which needs a picked version. */
export function flow(state: Flow, action: FlowAction): Flow {
  switch (action.type) {
    case "pick":
      return { picked: action.version, confirming: false };
    case "ask":
      return state.picked ? { ...state, confirming: true } : state;
    case "cancel":
    case "restored":
      return { ...state, confirming: false };
  }
}

/** Restoring changes nothing when the file already reads as the version. */
export function canRestore(state: Flow, current: string, version: string | null): boolean {
  return state.picked !== null && version !== null && current !== version;
}

/** Waits before the next read so reads stay `gap` ms apart; 0 when that time has passed. */
export function delayUntilNext(lastRead: number, now: number, gap: number): number {
  return Math.max(0, lastRead + gap - now);
}
