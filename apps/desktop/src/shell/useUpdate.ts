import { useCallback, useEffect, useState } from "react";
import type { Api } from "@/api";
import { useI18n } from "@/i18n";

export type Update = { version: string; notes: string | null; status: "ready" | "restarting" | "failed" };

export type UpdateStep = { kind: "ready"; version: string; notes: string | null } | { kind: "restarting" } | { kind: "failed" } | { kind: "handed" } | { kind: "none" };

export function nextUpdate(current: Update | null, step: UpdateStep): Update | null {
  switch (step.kind) {
    case "ready":
      // A newer download must not hide an install that is already running.
      return current?.status === "restarting" ? current : { version: step.version, notes: step.notes, status: "ready" };
    case "restarting":
      return current && { ...current, status: "restarting" };
    case "failed":
      return current && { ...current, status: "failed" };
    case "handed":
      // The quit guard has the restart now; if the person cancels there, the button is back.
      return current && { ...current, status: "ready" };
    case "none":
      return null;
  }
}

// Module scope so a vault switch, which remounts the view, does not notify again.
const notified = new Set<string>();

/** True the first time this session sees `version`. */
export function firstSeen(seen: Set<string>, version: string): boolean {
  if (seen.has(version)) return false;
  seen.add(version);
  return true;
}

/** An update Rust has downloaded in the background. The person is told once and restarts when they choose. */
export function useUpdate(api: Api): { state: Update | null; restart(): void } {
  const { t } = useI18n();
  const [state, setState] = useState<Update | null>(null);
  useEffect(() => {
    let stale = false;
    let off: (() => void) | undefined;
    const ready = (found: { version: string; notes: string | null }) => {
      if (stale) return;
      setState((s) => nextUpdate(s, { kind: "ready", ...found }));
      if (firstSeen(notified, found.version)) {
        const vars = { version: found.version };
        void api.notifyUpdate(t("status.updateReadyTitle", vars), t("status.updateReadyBody", vars)).catch(() => {});
      }
    };
    // Listens first so a download finishing in between is not missed.
    void api
      .onUpdateReady(ready)
      .then((unlisten) => {
        if (stale) return unlisten();
        off = unlisten;
        return api.updateStatus().then((found) => found && ready(found));
      })
      .catch(() => {});
    return () => {
      stale = true;
      off?.();
    };
  }, [api, t]);
  const restart = useCallback(() => {
    setState((s) => nextUpdate(s, { kind: "restarting" }));
    // The restart goes through the same quit guard as a click on the close button; the quit installs
    // the pending update and starts the app again.
    api.shellQuit("restart").then(
      () => setState((s) => nextUpdate(s, { kind: "handed" })),
      () => setState((s) => nextUpdate(s, { kind: "failed" })),
    );
  }, [api]);
  return { state, restart };
}
