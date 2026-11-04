import type { Api, WorkerLifetime } from "@/api";

export type StripState = { kind: "hidden" } | { kind: "running" } | { kind: "finished"; countdown: string };

/** `m:ss`, rounded up to a whole second and never below 0:00. */
export function countdownText(remainingMs: number): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** What the strip needs besides the lifetime: the auto-close setting and whether the tab has a running agent. */
export interface StripContext {
  autoClose: boolean;
  running: boolean;
}

/**
 * What the strip over a worker's terminal shows. Nothing for a tab that is no worker, one that is
 * kept open, or any worker while auto-close is off. A finished worker with a close time shows the
 * countdown. With no close time the rule shows while the agent runs (a worker that works again after
 * finishing has its close time cleared); with no running agent either (a start that failed) nothing
 * will close the tab, so nothing shows.
 */
export function stripState(lifetime: WorkerLifetime | null, nowMs: number, ctx: StripContext): StripState {
  if (lifetime === null || lifetime.kept || !ctx.autoClose) return { kind: "hidden" };
  if (lifetime.finished && lifetime.closesAtMs !== null) return { kind: "finished", countdown: countdownText(lifetime.closesAtMs - nowMs) };
  return ctx.running ? { kind: "running" } : { kind: "hidden" };
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
