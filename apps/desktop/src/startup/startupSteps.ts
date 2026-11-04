import type { StartupStep } from "@/api";

/** The step that does not raise the banner: the terminal host has its own fallback notice. */
export const QUIET_STEP = "ptyd";
/** The one step a restart can fix, so the banner offers it. */
export const RESTART_STEP = "layout.restore";

/** The i18n key of a step label; a step this build does not know gets the generic one. */
export function stepLabelKey(id: string): string {
  return KNOWN.has(id) ? `startup.step.${id}` : "startup.step.other";
}

const KNOWN = new Set([
  "data_dir",
  "logs",
  "crash_store",
  "settings",
  "ptyd",
  "hooks_marker",
  "endpoint",
  "keybindings_watcher",
  "hooks_watcher",
  RESTART_STEP,
  "ui.first_render",
]);

/** The steps the banner is about: failed ones, minus `ptyd`. */
export function failedSteps(steps: readonly StartupStep[]): StartupStep[] {
  return steps.filter((s) => !s.ok && s.id !== QUIET_STEP);
}

/** The text "Copy details" puts on the clipboard: one `[startup]` line per failed step. */
export function startupText(steps: readonly StartupStep[]): string {
  return steps
    .map((s) => `[startup] ${s.id} ok=${s.ok} t=${s.ms}${s.detail ? ` detail=${s.detail}` : ""}`)
    .join("\n");
}

const listeners = new Set<() => void>();

/** The banner refetches the report when a step is marked from the UI. Returns the unsubscribe. */
export function onStartupChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/** Records a step from the UI, then tells the banner. Never rejects. */
export async function markStartup(api: { startupMark?(step: StartupStep): Promise<void> }, step: StartupStep): Promise<void> {
  try {
    await api.startupMark?.(step);
  } catch {
    return;
  }
  for (const cb of [...listeners]) cb();
}
