import type { Api, WorkerFailover } from "@/api";
import type { ToastInput } from "./toastStore";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** One toast per failed worker: a repeat of the same event replaces it. */
export const failoverToastId = (e: WorkerFailover): string => `orchestration-failover:${e.fromDispatch}`;

/** The toast text: who took over from whom and why, a restart, or a worker marked failed. */
export function failoverText(e: WorkerFailover, name: (agent: string) => string, t: Translate): string {
  const reason = t(`orchestration.failover.reason.${e.reason}`);
  const from = name(e.fromAgent);
  if (e.kind === "restart") return t("orchestration.failover.toast.restart", { from, reason });
  if (e.kind === "failover") return t("orchestration.failover.toast.failover", { from, reason, to: name(e.agent ?? e.fromAgent) });
  return t("orchestration.failover.toast.failed", { from, reason });
}

/** Shows each `orchestration://failover` event as one toast. Returns the stop. */
export function watchFailovers(deps: { api: Pick<Api, "onOrchestrationFailover" | "profiles">; t: Translate; toast(input: ToastInput): string }): () => void {
  const { api, t, toast } = deps;
  let stopped = false;
  let unlisten: (() => void) | null = null;

  async function show(e: WorkerFailover): Promise<void> {
    // The backend names agents by profile id; the toast uses their names when they can be read.
    const names = await api.profiles().then(
      (v) => new Map(v.profiles.map((p) => [p.profile.id, p.profile.name])),
      () => new Map<string, string>(),
    );
    if (stopped) return;
    toast({ id: failoverToastId(e), text: failoverText(e, (agent) => names.get(agent) ?? agent, t) });
  }

  void api
    .onOrchestrationFailover((e) => {
      if (!stopped) void show(e);
    })
    .then((off) => {
      if (stopped) off();
      else unlisten = off;
    })
    .catch(() => {});

  return () => {
    stopped = true;
    unlisten?.();
  };
}
