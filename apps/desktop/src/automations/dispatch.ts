import type { Api, ApiError, AutomationDispatch, FailureCode, SetupDecision } from "@/api";
import { sendToChosenTab, sendToOpenedTab } from "@/workspace/agentPrompt";
import type { Sessions, Tab } from "@/workspace/sessions";

/** The output kept of a run: the last lines of its terminal, as many as the backend keeps. */
export const SNAPSHOT_LINES = 2000;

/** How long an agent gets to start working on the prompt before the run is failed. */
export const START_DEADLINE_MS = 120_000;

/** What the dispatch client needs from the window. */
export interface DispatchHost {
  sessions: Pick<Sessions, "open" | "tabs" | "subscribe">;
  /** Lists and mounts `worktree` (hidden) so its tabs start a pty; a worktree made for the run is not listed yet. */
  ensureMounted(worktree: string): void;
  /** What a worktree made for a run does about setup: `run` starts it; `inherit` starts it only when the repo's setup is trusted with a Run policy; `skip` does nothing. */
  setup(worktree: string, repoId: string, decision: SetupDecision): Promise<void> | void;
  /** Runs `launch` at once, or after setup has exited when the repo waits for it; false means "run it now". */
  defer(worktree: string, launch: () => void): boolean;
  /** The last `max` lines of a tab's terminal; null when it has none (not mounted, or closed). */
  terminalLines(tabId: string, max: number): string[] | null;
}

const idleOrDone = (tab: Tab) => tab.status === "done" || tab.status === "idle";
const running = (tab: Tab) => tab.agent && tab.exitCode === undefined;

/**
 * Opens a tab for each `automation://dispatch`, types the prompt, reports how the launch went
 * (once per run) and, when the tab ends, how the run did. Tells the backend the window is ready.
 * Returns the stop.
 */
export function startAutomationDispatch(api: Api, host: DispatchHost): () => void {
  const reported = new Set<string>();
  const finished = new Set<string>();
  const watchers = new Set<() => void>();
  let stopped = false;

  const report = (runId: string, result: { tabId: string } | { code: FailureCode; detail?: string }) => {
    if (reported.has(runId)) return;
    reported.add(runId);
    const call = "tabId" in result
      ? api.automationDispatchResult({ status: "dispatched", runId, tabId: result.tabId })
      : api.automationDispatchResult({ status: "failed", runId, code: result.code, detail: result.detail ?? null });
    void call.catch(() => {});
  };

  const finish = (runId: string, tabId: string, completed: boolean) => {
    if (finished.has(runId)) return;
    finished.add(runId);
    // One line more than is kept tells a cut terminal from one of exactly that many lines.
    const lines = completed ? host.terminalLines(tabId, SNAPSHOT_LINES + 1) : null;
    const truncated = lines !== null && lines.length > SNAPSHOT_LINES;
    const kept = lines && truncated ? lines.slice(-SNAPSHOT_LINES) : lines;
    void api
      .automationRunFinish({ runId, completed, output: kept ? kept.join("\n") : null, truncated })
      .catch(() => {});
  };

  /** Follows the tab: `working` then `done` completes the run; ending first, or a failed turn, does not. */
  const watch = (runId: string, worktree: string, tabId: string) => {
    let worked = false;
    // An agent that does not start working on the prompt in time fails the run; the backend takes
    // that report from a run that is already launched.
    const never = setTimeout(() => {
      if (worked || stopped || finished.has(runId)) return;
      end();
      finished.add(runId);
      void api.automationDispatchResult({ status: "failed", runId, code: "agentNeverStarted", detail: null }).catch(() => {});
    }, START_DEADLINE_MS);
    // One stop for both the run's end and the dispatcher's, so `end` removes what was added.
    const stop = () => {
      clearTimeout(never);
      off();
    };
    const end = () => {
      stop();
      watchers.delete(stop);
    };
    const off = host.sessions.subscribe(() => {
      if (stopped) return;
      const tab = host.sessions.tabs(worktree).find((t) => t.id === tabId);
      if (!tab || tab.exitCode !== undefined || tab.status === "exited" || tab.status === "failed") {
        end();
        finish(runId, tabId, false);
        return;
      }
      if (tab.status === "working") {
        worked = true;
        clearTimeout(never);
      } else if (tab.status === "done" && worked) {
        end();
        finish(runId, tabId, true);
      }
    });
    watchers.add(stop);
  };

  /** Resolves `refused` when the tab's spawn is refused by the policy gate or fails. */
  const refusal = (tab: Tab): { promise: Promise<ApiError>; stop: () => void } => {
    let stop = () => {};
    const promise = new Promise<ApiError>((resolve) => {
      if (tab.client.startError) return resolve(tab.client.startError);
      stop = tab.client.onStartError(resolve);
    });
    return { promise, stop };
  };

  const launch = async (e: AutomationDispatch) => {
    const sessions = host.sessions as Sessions;
    try {
      const old = e.reuseTab ? sessions.tabs(e.worktree).find((t) => t.id === e.reuseTab) : undefined;
      if (old && running(old) && idleOrDone(old)) {
        const tab = await sendToChosenTab(sessions, e.worktree, { tab: old.id }, e.prompt);
        if (tab) {
          report(e.runId, { tabId: tab.id });
          watch(e.runId, e.worktree, tab.id);
          return;
        }
      }
      const opened = sessions.open(e.worktree, e.profile, null, undefined, { extraArgs: e.extraArgs.length > 0 ? e.extraArgs : undefined });
      const refused = refusal(opened);
      // A refusal ends the launch: a tab approved later must not get the prompt of a skipped run.
      let gaveUp = false;
      const sent = sendToOpenedTab(sessions, e.worktree, opened.id, e.prompt, { timeoutMs: START_DEADLINE_MS, cancelled: () => gaveUp || stopped });
      const first = await Promise.race([sent, refused.promise.then((err) => ((gaveUp = true), { err }))]);
      refused.stop();
      if (first && "err" in first) {
        const needs = first.err.code === "needs_approval";
        report(e.runId, { code: needs ? "needsApproval" : "agentNeverStarted", detail: first.err.detail });
        return;
      }
      if (!first) return report(e.runId, { code: "agentNeverStarted" });
      report(e.runId, { tabId: first.id });
      watch(e.runId, e.worktree, first.id);
    } catch (err) {
      report(e.runId, { code: "agentNeverStarted", detail: err instanceof Error ? err.message : String(err) });
    }
  };

  const offs = [
    api.onAutomationDispatch((e) => {
      if (stopped) return;
      void (async () => {
        // Tabs only start in a mounted worktree; one made for this run is not listed yet.
        host.ensureMounted(e.worktree);
        // Setup starts first, so the repo's "wait for setup" can hold the agent back.
        if (e.created) await Promise.resolve(host.setup(e.worktree, e.repoId, e.setup)).catch(() => {});
        if (stopped) return;
        const go = () => void launch(e);
        if (!host.defer(e.worktree, go)) go();
      })();
    }),
  ];
  void api.automationUiReady().catch(() => {});

  return () => {
    stopped = true;
    for (const off of watchers) off();
    watchers.clear();
    for (const off of offs) void off.then((stop) => stop()).catch(() => {});
  };
}
