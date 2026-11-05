import { Button, StatusDot } from "@xdev-asia/ui";
import type { JSX } from "react";
import { useI18n } from "@/i18n";
import type { Answers } from "../onboardingState";

/** Step 4: lets the OS ask for notifications, so a waiting agent can reach the person. */
export function NotificationsStep(props: { answers: Answers; busy: boolean; onAllow(): void }): JSX.Element {
  const { t } = useI18n();
  const status = props.answers.notifications;
  return (
    <div className="ws-fields">
      <p className="onb-hint">{t("onboarding.notifications.hint")}</p>
      {status === "allowed" ? (
        <StatusDot tone="ok" label={t("onboarding.notifications.allowed")} />
      ) : (
        <>
          <Button type="button" variant="secondary" disabled={props.busy} onClick={props.onAllow}>
            {t("onboarding.notifications.allow")}
          </Button>
          {status === "denied" && <StatusDot tone="warn" label={t("onboarding.notifications.denied")} />}
        </>
      )}
    </div>
  );
}
