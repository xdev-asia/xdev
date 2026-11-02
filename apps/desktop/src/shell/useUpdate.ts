import { useCallback, useEffect, useState } from "react";
import type { Api } from "../api";

const RECHECK_MS = 6 * 3_600_000;

export type Update = { version: string; notes: string | null; status: "ready" | "installing" | "failed" };

export type UpdateStep = { kind: "found"; version: string; notes: string | null } | { kind: "none" } | { kind: "installing" } | { kind: "failed" };

export function nextUpdate(current: Update | null, step: UpdateStep): Update | null {
  switch (step.kind) {
    case "found":
      // A later check must not reset an install that is already running.
      return current?.status === "installing" ? current : { version: step.version, notes: step.notes, status: "ready" };
    case "none":
      return current?.status === "installing" ? current : null;
    case "installing":
      return current && { ...current, status: "installing" };
    case "failed":
      return current && { ...current, status: "failed" };
  }
}

/** A newer signed release, if any. Check failures (offline, no release yet) show nothing. */
export function useUpdate(api: Api): { state: Update | null; install(): void } {
  const [state, setState] = useState<Update | null>(null);
  useEffect(() => {
    let stale = false;
    const check = () =>
      api.checkUpdate().then(
        (found) => !stale && setState((s) => nextUpdate(s, found ? { kind: "found", ...found } : { kind: "none" })),
        () => {},
      );
    void check();
    const timer = setInterval(check, RECHECK_MS);
    return () => {
      stale = true;
      clearInterval(timer);
    };
  }, [api]);
  const install = useCallback(() => {
    setState((s) => nextUpdate(s, { kind: "installing" }));
    // Success restarts the app; resolving means the release was gone by then.
    api.installUpdate().then(
      () => setState(null),
      () => setState((s) => nextUpdate(s, { kind: "failed" })),
    );
  }, [api]);
  return { state, install };
}
