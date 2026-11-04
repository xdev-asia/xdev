import { Banner, Button } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { Api, StartupStep } from "@/api";
import { useI18n } from "@/i18n";
import { copyText } from "@/ui/clipboard";
import { pushToast } from "@/workspace/toastStore";
import { failedSteps, onStartupChange, RESTART_STEP, startupText, stepLabelKey } from "./startupSteps";

/** What the banner shows for a list of steps. Nothing when none failed (or only `ptyd`). */
export function StartupBannerView(props: { steps: readonly StartupStep[]; onRestart(): void; onCopy(): void }): JSX.Element | null {
  const { t } = useI18n();
  const failed = failedSteps(props.steps);
  if (failed.length === 0) return null;
  const restart = failed.some((s) => s.id === RESTART_STEP);
  return (
    <Banner
      title={t("startup.title")}
      action={
        <div className="banner-actions">
          {restart ? (
            <Button variant="secondary" type="button" onClick={props.onRestart}>
              {t("startup.restart")}
            </Button>
          ) : (
            <Button variant="secondary" type="button" onClick={props.onCopy}>
              {t("startup.copy")}
            </Button>
          )}
        </div>
      }
    >
      {t("startup.body")}
      <ul className="startup-steps">
        {failed.map((s) => (
          <li key={s.id}>{t(stepLabelKey(s.id))}</li>
        ))}
      </ul>
    </Banner>
  );
}

/** Loads the startup report and shows the banner while a step has failed. */
export function StartupBanner(props: { api: Pick<Api, "startupReport" | "appRelaunch"> }): JSX.Element | null {
  const { api } = props;
  const { t } = useI18n();
  const [steps, setSteps] = useState<StartupStep[]>([]);

  useEffect(() => {
    let live = true;
    const load = () =>
      void api
        .startupReport()
        .then((r) => live && setSteps(r.steps))
        .catch(() => {});
    load();
    const off = onStartupChange(load);
    return () => {
      live = false;
      off();
    };
  }, [api]);

  return (
    <StartupBannerView
      steps={steps}
      onRestart={() => void api.appRelaunch().catch(() => {})}
      onCopy={() =>
        void copyText(startupText(failedSteps(steps))).then((ok) => pushToast({ text: t(ok ? "startup.copied" : "startup.copyFailed") }))
      }
    />
  );
}
