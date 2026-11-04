import type { Api, CrashReport, RenderCrash } from "@/api";

/** Keys of reports already sent; a boundary that re-renders into the same error reports it once. */
const MAX_KEYS = 50;
const seen: string[] = [];
const listeners = new Set<(report: CrashReport) => void>();

export function crashKey(c: Pick<RenderCrash, "boundary" | "surface" | "name" | "message" | "componentStack">): string {
  return JSON.stringify({
    id: c.boundary,
    surface: c.surface,
    errorName: c.name,
    message: c.message,
    componentStack: c.componentStack,
  });
}

/** Whether the key is new; remembers it, dropping the oldest of 50. */
export function firstSight(key: string): boolean {
  if (seen.includes(key)) return false;
  seen.push(key);
  if (seen.length > MAX_KEYS) seen.shift();
  return true;
}

/** Forgets every key; for tests. */
export function resetSurfaceReports(): void {
  seen.length = 0;
}

/** Called with each new report a boundary produced; the crash dialog listens here. Returns the unsubscribe. */
export function onSurfaceReport(cb: (report: CrashReport) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Sends a render crash to the store once. Never throws: a failing report must not break the fallback. */
export async function reportSurfaceCrash(api: Pick<Api, "crashRecordRender">, crash: RenderCrash): Promise<void> {
  if (!firstSight(crashKey(crash))) return;
  try {
    const report = await api.crashRecordRender(crash);
    if (report) for (const cb of [...listeners]) cb(report);
  } catch (e) {
    console.error("[crash] could not record the report", e);
  }
}
