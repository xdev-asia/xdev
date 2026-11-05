import type { SkillStatus } from "@/api";

export const TIP_KEY = "xdev.tip.cliSkill";

/** Whether "Maybe later" was chosen on this computer; false when storage cannot be read. */
export function loadTipDismissed(): boolean {
  try {
    return localStorage.getItem(TIP_KEY) === "dismissed";
  } catch {
    return false;
  }
}

export function saveTipDismissed(): void {
  try {
    localStorage.setItem(TIP_KEY, "dismissed");
  } catch {
    // The tip comes back next run; nothing else depends on it.
  }
}

/** The tip shows once the status is known and the skill is missing, unless it was dismissed, already showed this run, or onboarding has the screen. */
export function tipVisible(input: { status: Pick<SkillStatus, "installed"> | null; dismissed: boolean; shownThisRun: boolean; suppressed: boolean }): boolean {
  if (input.status === null || input.status.installed) return false;
  return !input.dismissed && !input.shownThisRun && !input.suppressed;
}

let shown = false;

export function markShown(): void {
  shown = true;
}

export function shownThisRun(): boolean {
  return shown;
}

export function resetTipForTests(): void {
  shown = false;
}
