import type { Api, CrashReport } from "@/api";
import { onSurfaceReport } from "./surfaceReport";

/** What the dialog should show: a report, or the latest one on demand. */
export type CrashOpen = { report: CrashReport } | { latest: true };

const openers = new Set<(open: CrashOpen) => void>();

/** Asks the crash dialog to open. Nothing happens when it is not mounted. */
export function openCrashDialog(open: CrashOpen): void {
  for (const cb of [...openers]) cb(open);
}

/** The dialog host listens here. Also opens on a new boundary report (#70). Returns the unsubscribe. */
export function onCrashOpen(cb: (open: CrashOpen) => void): () => void {
  openers.add(cb);
  const off = onSurfaceReport((report) => cb({ report }));
  return () => {
    openers.delete(cb);
    off();
  };
}

// The listener takes the event as `any`: `window` and a test double type their events differently.
type Target = {
  addEventListener(type: string, cb: (e: any) => void): void;
  removeEventListener(type: string, cb: (e: any) => void): void;
};

/** The browser's own noise for a resize observer that needed another frame; not a fault. */
const IGNORED = /ResizeObserver loop/i;

/** Window errors and rejected promises become breadcrumbs of the next report. They are not reports. */
export function startCrashBreadcrumbs(api: Pick<Api, "crashBreadcrumb">, target: Target = window): () => void {
  const send = (name: string, message: string) => {
    void api.crashBreadcrumb(name, [{ key: "message", value: message.slice(0, 240) }]).catch(() => {});
  };
  const onError = (e: { message?: string }) => {
    const message = e.message ?? "unknown error";
    if (IGNORED.test(message)) return;
    send("renderer_error", message);
  };
  const onRejection = (e: { reason?: unknown }) => {
    const r = e.reason;
    send("renderer_unhandled_rejection", r instanceof Error ? r.message : String(r));
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
