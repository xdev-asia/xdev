import type { Api, ReadTab, WorkerClose, WorkerOpen, WorkerOpenOutcome } from "@/api";
import type { TerminalHandle } from "@/terminal/Terminal";
import type { SetupGate } from "./setupGate";
import { pushToast } from "./toastStore";
import type { Sessions, Tab } from "./sessions";

/** Where an open went wrong; the backend puts it in the receipt (`failedStage`). */
export type OpenStage = Extract<WorkerOpenOutcome, { kind: "failed" }>["stage"];

/** The most buffer lines a `read-tab` looks at before it cuts to `maxChars`. */
export const READ_LINES = 10_000;

export interface OrchestrationHost {
  sessions: Pick<Sessions, "open" | "close" | "tab">;
  gate: Pick<SetupGate, "defer" | "state">;
  /** Types `text` into tab `id` once its agent has started; null at the timeout or when the tab ends. */
  send(worktree: string, id: string, text: string, timeoutMs: number): Promise<Tab | null>;
  /** Makes sure the worktree's tabs are mounted (and listed), so a tab opened there gets its pty. */
  ensureMounted?(worktree: string): void;
  /** Runs the repo's setup for a worktree that has none under way and was not set up yet (one the backend just made). */
  prepareSetup?(worktree: string): Promise<void>;
  /** The xterm of a tab, when it is mounted. */
  terminal(id: string): Pick<TerminalHandle, "lines"> | null;
  /** An open failed; the shell shows a toast. */
  failed?(open: WorkerOpen, stage: OpenStage, error: string): void;
  /** The clock for the shared readiness budget. */
  now?(): number;
  /** Shows a hidden (swarm) worker's tab: selects its worktree and the tab. */
  reveal?(tab: string): void;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : typeof e === "string" ? e : "failed");

/** Opens one worker tab and answers the backend once. */
export async function openWorker(api: Api, host: OrchestrationHost, open: WorkerOpen): Promise<WorkerOpenOutcome> {
  const started = (host.now ?? Date.now)();
  const fail = (stage: OpenStage, error: string): WorkerOpenOutcome => {
    host.failed?.(open, stage, error);
    return { kind: "failed", stage, error };
  };
  host.ensureMounted?.(open.worktree);
  // The agent must be on and installed, as for a default agent; a bad one fails here, not as a readiness timeout.
  try {
    const found = (await api.profiles()).profiles.find((p) => p.profile.id === open.profile);
    if (!found?.profile.enabled || !found.installed) return fail("terminal_create", `agent ${open.profile} is not available`);
  } catch (e) {
    return fail("terminal_create", message(e));
  }
  const make = (): Tab => host.sessions.open(open.worktree, open.profile, open.account ?? null, undefined, { id: open.tab, title: open.title, background: true });
  let tab: Tab;
  try {
    if (open.setup === "skip") {
      tab = make();
    } else {
      try {
        await host.prepareSetup?.(open.worktree);
      } catch {
        // No setup then; the agent starts as it would without one.
      }
      let opened: Tab | undefined;
      let thrown: { error: unknown } | undefined;
      const held = await new Promise<"go" | "failed">((resolve) => {
        let over = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const stop = (v: "go" | "failed"): void => {
          if (over) return;
          over = true;
          clearTimeout(timer);
          resolve(v);
        };
        const launch = (): void => {
          if (over) return;
          try {
            opened = make();
          } catch (error) {
            thrown = { error };
          }
          stop("go");
        };
        if (!host.gate.defer(open.worktree, launch)) return launch();
        timer = setTimeout(() => stop("failed"), Math.max(0, open.readyTimeoutMs - ((host.now ?? Date.now)() - started)));
      });
      if (held === "failed") return fail("setup_wait", host.gate.state(open.worktree)?.phase === "failed" ? "setup failed" : "setup did not finish in time");
      if (thrown) throw thrown.error;
      tab = opened!;
    }
  } catch (e) {
    return fail("terminal_create", message(e));
  }
  const left = Math.max(0, open.readyTimeoutMs - ((host.now ?? Date.now)() - started));
  let sent: Tab | null;
  try {
    sent = await host.send(open.worktree, tab.id, open.prompt, left);
  } catch (e) {
    return fail("dispatch_input", message(e));
  }
  if (!sent) return fail("agent_readiness", "the agent was not ready in time");
  return { kind: "ok" };
}

/**
 * The last `maxChars` characters of the tab's terminal text, or its last `maxLines` lines when that is set; "" for a
 * tab that has no terminal.
 */
export function readTab(host: OrchestrationHost, e: ReadTab): string {
  if (e.maxLines !== undefined) return (host.terminal(e.tab)?.lines(e.maxLines) ?? []).join("\n");
  const lines = host.terminal(e.tab)?.lines(READ_LINES) ?? [];
  const text = lines.join("\n");
  if (e.maxChars >= text.length) return text;
  if (e.maxChars === 0) return "";
  const cut = text.slice(text.length - e.maxChars);
  // A cut between the two halves of a surrogate pair leaves a lone low half first; drop it.
  const first = cut.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? cut.slice(1) : cut;
}

/** Follows `orchestration://` events until the returned stop is called. */
export function startOrchestrationEvents(api: Api, host: OrchestrationHost): () => void {
  const inFlight = new Set<string>();
  const offs = [
    api.onOrchestrationOpenWorker((e) => {
      // The same dispatch twice is one open.
      if (inFlight.has(e.dispatch)) return;
      inFlight.add(e.dispatch);
      void openWorker(api, host, e)
        .then((outcome) => api.orchestrationWorkerOpened(e.dispatch, outcome))
        .catch(() => {})
        .finally(() => inFlight.delete(e.dispatch));
    }),
    api.onOrchestrationCloseWorker((e: WorkerClose) => {
      if (host.sessions.tab(e.tab)) void host.sessions.close(e.tab).catch(() => {});
    }),
    api.onOrchestrationReadTab((e) => void api.orchestrationReadAnswer(e.request, readTab(host, e)).catch(() => {})),
    api.onOrchestrationRevealTab((e) => host.reveal?.(e.tab)),
  ];
  return () => {
    for (const off of offs) void off.then((stop) => stop()).catch(() => {});
  };
}

/** The toast for a worker that did not open: its title and the stage that failed. */
export function openFailedToast(open: WorkerOpen, stage: OpenStage, t: (key: string, vars?: Record<string, string | number>) => string): string {
  return pushToast({ id: `orchestration-open-${open.dispatch}`, text: t("orchestration.worker.openFailed", { title: open.title, stage: t(`orchestration.worker.stage.${stage}`) }) });
}
