import { Banner, Button } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { Api, WorkerLifetime } from "@/api";
import { useI18n } from "@/i18n";
import { counting, keepOpen, stripState } from "./workerLifetime";

/**
 * The notice over the terminal of an orchestration worker: it closes by itself 2 minutes after it
 * finishes, unless kept. Renders nothing for a tab that is no worker.
 */
export function WorkerStrip(props: { api: Api; tab: string; /** The tab has a running agent. */ running?: boolean; now?: () => number }): JSX.Element | null {
  const { api, tab } = props;
  const { t } = useI18n();
  const clock = props.now ?? Date.now;
  const [lifetime, setLifetime] = useState<WorkerLifetime | null>(null);
  // Closing is off until the setting says on, so no strip flashes a rule that does not hold.
  const [autoClose, setAutoClose] = useState(false);
  const [now, setNow] = useState(() => clock());

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

  if (state.kind === "hidden") return null;
  return (
    <div className="ws-worker-strip" data-worker-strip={state.kind}>
      <Banner
        title={state.kind === "finished" ? t("orchestration.worker.finished", { countdown: state.countdown }) : t("orchestration.worker.running")}
        action={
          <Button type="button" variant="secondary" data-act="keep-open" onClick={() => void keepOpen(api, tab, lifetime, setLifetime)}>
            {t("orchestration.worker.keepOpen")}
          </Button>
        }
      />
    </div>
  );
}
