import type { Tab } from "@/workspace/sessions";

/** How long a terminal must stay quiet to count as idle, and the longest a wait lasts. */
export const IDLE_QUIET_MS = 1_500;
export const IDLE_TIMEOUT_MS = 30_000;

/** The slice of `Sessions` a wait needs. */
export interface TabWatch {
  subscribe(listener: () => void): () => void;
  find(): Tab | undefined;
}

/**
 * Resolves true once the tab is not working or asking (status `idle` or `done`) and stays so for
 * `quietMs`; false at `timeoutMs` or when the tab is gone. Shell tabs report no work, so for them
 * this is a fixed `quietMs` pause. [Inference] A shell's busy command is not seen unless its title says so.
 */
export function waitIdle(watch: TabWatch, quietMs = IDLE_QUIET_MS, timeoutMs = IDLE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let quiet: ReturnType<typeof setTimeout> | undefined;
    let off = () => {};
    const finish = (ok: boolean) => {
      clearTimeout(quiet);
      clearTimeout(limit);
      off();
      resolve(ok);
    };
    const limit = setTimeout(() => finish(false), timeoutMs);
    const check = () => {
      const tab = watch.find();
      if (!tab || tab.exitCode !== undefined) return finish(false);
      const calm = tab.status !== "working" && tab.status !== "needs-you";
      if (calm && quiet === undefined) quiet = setTimeout(() => finish(true), quietMs);
      else if (!calm && quiet !== undefined) {
        clearTimeout(quiet);
        quiet = undefined;
      }
    };
    off = watch.subscribe(check);
    check();
  });
}
