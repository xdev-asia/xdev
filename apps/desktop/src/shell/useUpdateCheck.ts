import { useCallback, useEffect, useReducer } from "react";
import type { Api, UpdatePhase } from "@/api";

export type CheckState = { phase: UpdatePhase; restart: "idle" | "restarting" | "failed" };

export type CheckAction = { kind: "phase"; phase: UpdatePhase } | { kind: "restarting" } | { kind: "restartFailed" } | { kind: "restartDone" };

export const INITIAL_CHECK: CheckState = { phase: { kind: "idle" }, restart: "idle" };

export function nextCheck(current: CheckState, action: CheckAction): CheckState {
  switch (action.kind) {
    case "phase":
      // A phase from a background check must not hide an install that is already running.
      return current.restart === "restarting" ? current : { phase: action.phase, restart: "idle" };
    case "restarting":
      return { ...current, restart: "restarting" };
    case "restartFailed":
      return { ...current, restart: "failed" };
    case "restartDone":
      return { phase: { kind: "up-to-date" }, restart: "idle" };
  }
}

/** The i18n key (and its vars) of the status line for a state. */
export function phaseLine(state: CheckState): { key: string; vars?: Record<string, string | number> } {
  const p = state.phase;
  if (state.restart === "failed") return { key: "settings.general.updates.restartFailed" };
  switch (p.kind) {
    case "idle":
      return { key: "settings.general.updates.idle" };
    case "checking":
      return { key: "settings.general.updates.checking" };
    case "up-to-date":
      return { key: "settings.general.updates.upToDate" };
    case "downloading":
      return p.percent === null
        ? { key: "settings.general.updates.downloadingUnknown", vars: { version: p.version } }
        : { key: "settings.general.updates.downloading", vars: { version: p.version, percent: p.percent } };
    case "ready":
      return { key: "settings.general.updates.ready", vars: { version: p.version } };
    case "error":
      return { key: "settings.general.updates.error", vars: { detail: p.detail } };
  }
}

/** The update check as the Updates setting shows it: the phase Rust is in, a manual check and the restart. */
export function useUpdateCheck(api: Pick<Api, "updateCheck" | "updatePhase" | "onUpdatePhase" | "restartToUpdate">): {
  state: CheckState;
  check(rc: boolean): Promise<void>;
  restart(): void;
} {
  const [state, dispatch] = useReducer(nextCheck, INITIAL_CHECK);
  useEffect(() => {
    let stale = false;
    let off: (() => void) | undefined;
    // Listens first so a phase between the listen and the read is not missed.
    void api
      .onUpdatePhase((phase) => !stale && dispatch({ kind: "phase", phase }))
      .then((unlisten) => {
        if (stale) return unlisten();
        off = unlisten;
        return api.updatePhase().then((phase) => !stale && dispatch({ kind: "phase", phase }));
      })
      .catch(() => {});
    return () => {
      stale = true;
      off?.();
    };
  }, [api]);
  const check = useCallback(
    async (rc: boolean) => {
      try {
        dispatch({ kind: "phase", phase: await api.updateCheck(rc) });
      } catch (e) {
        dispatch({ kind: "phase", phase: { kind: "error", detail: e instanceof Error ? e.message : String(e) } });
      }
    },
    [api],
  );
  const restart = useCallback(() => {
    dispatch({ kind: "restarting" });
    // Success restarts the app; resolving means nothing was pending any more.
    api.restartToUpdate().then(
      () => dispatch({ kind: "restartDone" }),
      () => dispatch({ kind: "restartFailed" }),
    );
  }, [api]);
  return { state, check, restart };
}
