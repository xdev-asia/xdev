import { Banner, Button } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { Api, FailedOver, WorkerLifetime } from "@/api";
import { useI18n } from "@/i18n";
import { counting, keepOpen, stripState } from "./workerLifetime";

type T = (key: string, vars?: Record<string, string | number>) => string;

/** "Failed over from Claude Code (out of quota)", or "Restarted after no output for too long". */
export function failoverLine(f: FailedOver, agentName: string, t: T): string {
  const reason = t(`orchestration.failover.reason.${f.reason}`);
  const line = f.kind === "restart" ? t("orchestration.worker.restarted", { reason }) : t("orchestration.worker.failedOver", { agent: agentName, reason });
  return f.account ? `${line} · ${t("orchestration.worker.failoverAccount", { account: f.account })}` : line;
}

/**
 * The notice over the terminal of an orchestration worker: it closes by itself 2 minutes after it
 * finishes, unless kept; and, for one that took over from a failed worker, where it came from.
 * Renders nothing for a tab that is no worker.
 */
export function WorkerStrip(props: { api: Api; tab: string; /** The tab has a running agent. */ running?: boolean; now?: () => number }): JSX.Element | null {
  const { api, tab } = props;
  const { t } = useI18n();
  const clock = props.now ?? Date.now;
  const [lifetime, setLifetime] = useState<WorkerLifetime | null>(null);
  // Closing is off until the setting says on, so no strip flashes a rule that does not hold.
  const [autoClose, setAutoClose] = useState(false);
  const [now, setNow] = useState(() => clock());
  const [failover, setFailover] = useState<{ from: FailedOver; agent: string } | null>(null);

  useEffect(() => {
    let live = true;
    const read = (): void => {
      api.orchestrationWorkerLifetime(tab).then(
        (v) => live && setLifetime(v),
        () => {},
      );
      api.orchestrationSettings().then(
        (v) => live && setAutoClose(v.workerAutoClose),
        () => {},
      );
      api.orchestrationWorkerFailover(tab).then(
        async (from) => {
          if (!from) return void (live && setFailover(null));
          // The backend knows the agent by its profile id; the strip names it.
          const name = await api.profiles().then(
            (v) => v.profiles.find((p) => p.profile.id === from.fromAgent)?.profile.name ?? from.fromAgent,
            () => from.fromAgent,
          );
          if (live) setFailover({ from, agent: name });
        },
        () => {},
      );
    };
    read();
    const off = api.onOrchestrationWorkerChanged((e) => {
      if (e.tab === tab) read();
    });
    return () => {
      live = false;
      void off.then((stop) => stop()).catch(() => {});
    };
  }, [api, tab]);

  const state = stripState(lifetime, now, { autoClose, running: props.running === true });
  const ticking = counting(state);
  useEffect(() => {
    if (!ticking) return;
    setNow(clock());
    const timer = setInterval(() => setNow(clock()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  if (state.kind === "hidden" && !failover) return null;
  return (
    <div className="ws-worker-strip" data-worker-strip={state.kind}>
      {failover && (
        <p className="ws-worker-failover" role="status" data-failover={failover.from.kind}>
          {failoverLine(failover.from, failover.agent, t)}
        </p>
      )}
      {state.kind !== "hidden" && <Banner
        title={state.kind === "finished" ? t("orchestration.worker.finished", { countdown: state.countdown }) : t("orchestration.worker.running")}
        action={
          <Button type="button" variant="secondary" data-act="keep-open" onClick={() => void keepOpen(api, tab, lifetime, setLifetime)}>
            {t("orchestration.worker.keepOpen")}
          </Button>
        }
      />}
    </div>
  );
}
