// One interruption per launch: the tips modal, a feature tour and the what's-new wall share a single slot. Pure parts first.

export type Interruption = "wall" | "tour" | "tip";

/** Who goes first when several want the screen: what's new, then a tour, then a tip. */
const RANK: Readonly<Record<Interruption, number>> = { wall: 3, tour: 2, tip: 1 };

/** True when `kind` may take the slot: it is free and nothing that outranks `kind` is waiting for it. */
export function mayClaim(kind: Interruption, claimed: Interruption | null, waiting: readonly Interruption[]): boolean {
  return claimed === null && !waiting.some((w) => RANK[w] > RANK[kind]);
}

let claimed: Interruption | null = null;

/** Takes the slot for this launch; false when it is taken or something that outranks `kind` is waiting. */
export function claimInterruption(kind: Interruption, waiting: readonly Interruption[] = []): boolean {
  if (!mayClaim(kind, claimed, waiting)) return false;
  claimed = kind;
  return true;
}

/** Whether something took the slot already. */
export const interruptionClaimed = (): boolean => claimed !== null;

// Calm: a tour starts only after the person stopped typing and the pane is not brand new.

/** No keyboard or pointer input for this long. */
export const CALM_IDLE_MS = 2000;
/** A terminal must have been on screen this long. */
export const CALM_PANE_MS = 2000;

/** Milliseconds still to wait before a tour may start; 0 when it may start now. `paneSince` is when the pane appeared (null: not on screen). */
export function calmWait(input: { now: number; lastInput: number; paneSince: number | null }): number {
  const idle = Math.max(0, CALM_IDLE_MS - (input.now - input.lastInput));
  const pane = input.paneSince === null ? 0 : Math.max(0, CALM_PANE_MS - (input.now - input.paneSince));
  return Math.max(idle, pane);
}

let lastInput = Date.now();
let tracking = false;

/** Listens (once) for keys, pointer and wheel input anywhere in the window. */
export function trackInput(): void {
  if (tracking || typeof window === "undefined") return;
  tracking = true;
  lastInput = Date.now();
  const note = (): void => void (lastInput = Date.now());
  for (const type of ["keydown", "pointerdown", "wheel", "input"]) window.addEventListener(type, note, { capture: true, passive: true });
}

/** The time of the last input seen (the time of the first call when none was). */
export function lastInputAt(): number {
  trackInput();
  return lastInput;
}

/** Tests only. */
export function resetInterruptionsForTests(): void {
  claimed = null;
  lastInput = Date.now();
}
