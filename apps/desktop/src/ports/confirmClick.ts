/** How long a confirm button that just appeared ignores clicks. */
export const CONFIRM_ARM_MS = 400;

/**
 * Whether a click on a confirm button counts. The 2nd and 3rd clicks of a
 * double or triple click (`detail > 1`) do not, nor does a click within
 * CONFIRM_ARM_MS of the button appearing in place of the one first clicked.
 */
export function confirmCounts(event: { detail?: number } | undefined, shownAt: number, now = Date.now()): boolean {
  if ((event?.detail ?? 0) > 1) return false;
  return now - shownAt >= CONFIRM_ARM_MS;
}
