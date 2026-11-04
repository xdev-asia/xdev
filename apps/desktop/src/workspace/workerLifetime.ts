import type { Api, WorkerLifetime } from "@/api";

export type StripState = { kind: "hidden" } | { kind: "running" } | { kind: "finished"; countdown: string };

/** `m:ss`, rounded up to a whole second and never below 0:00. */
export function countdownText(remainingMs: number): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * What the strip over a worker's terminal shows. Nothing for a tab that is no worker or one that is
 * kept open. A worker that has not finished, or that works again after finishing (its close time is
 * cleared), shows the rule; a finished one with a close time shows the countdown.
 */
export function stripState(lifetime: WorkerLifetime | null, nowMs: number): StripState {
  if (lifetime === null || lifetime.kept) return { kind: "hidden" };
  if (!lifetime.finished || lifetime.closesAtMs === null) return { kind: "running" };
  return { kind: "finished", countdown: countdownText(lifetime.closesAtMs - nowMs) };
}

/** Whether the strip needs a one-second tick: only while a countdown runs. */
export const counting = (s: StripState): boolean => s.kind === "finished";

/**
 * Keep open, optimistic: the strip hides at once, then shows what the backend stored. When the call
 * fails the strip reads the lifetime again, so it never claims a state the backend does not have.
 */
export async function keepOpen(api: Api, tab: string, current: WorkerLifetime | null, apply: (l: WorkerLifetime | null) => void): Promise<void> {
  if (current) apply({ ...current, kept: true });
  try {
    apply(await api.orchestrationWorkerKeepOpen(tab, true));
  } catch {
    apply(await api.orchestrationWorkerLifetime(tab).catch(() => current));
  }
}
