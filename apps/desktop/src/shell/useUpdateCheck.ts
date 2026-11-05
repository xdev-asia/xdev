import { useCallback, useEffect, useReducer } from "react";
import type { Api, UpdatePhase } from "@/api";

export type CheckState = { phase: UpdatePhase; restart: "idle" | "restarting" | "failed" };

export type CheckAction = { kind: "phase"; phase: UpdatePhase } | { kind: "restarting" } | { kind: "restartFailed" } | { kind: "restartDone" } | { kind: "restartHanded" };

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
    case "restartHanded":
      // The quit guard has the restart now; if the person cancels there, the button is back.
      return { ...current, restart: "idle" };
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
      // The raw error is English text from the updater: the view shows it apart, as a hint.
      return { key: "settings.general.updates.error" };
  }
}

/** The update check as the Updates setting shows it: the phase Rust is in, a manual check and the restart. */
export function useUpdateCheck(api: Pick<Api, "updateCheck" | "updatePhase" | "onUpdatePhase" | "shellQuit">): {
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
    // The restart goes through the same quit guard as a click on the close button; the quit installs
    // the pending update and starts the app again.
    api.shellQuit("restart").then(
      () => dispatch({ kind: "restartHanded" }),
      () => dispatch({ kind: "restartFailed" }),
    );
  }, [api]);
  return { state, check, restart };
}
