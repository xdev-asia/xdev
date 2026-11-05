import { Dialog, StatusDot } from "@xdev-asia/ui";
import type { JSX } from "react";
import type { Api } from "@/api";
import { useI18n } from "@/i18n";
import { doneCount, type Row } from "./checklist";
import { closeGuide, resumeOnboarding, useOnboarding } from "./onboardingStore";
import { useChecklist } from "./useChecklist";

/** The checklist with its "Resume setup" action. */
export function SetupGuideView(props: { rows: Row[]; onResume(): void; onClose(): void }): JSX.Element {
  const { t } = useI18n();
  return (
    <Dialog modal title={t("onboarding.guide.title")} confirmLabel={t("onboarding.guide.resume")} cancelLabel={t("onboarding.guide.close")} onConfirm={props.onResume} onCancel={props.onClose}>
      <p className="onb-hint">{t("onboarding.guide.progress", { done: doneCount(props.rows), total: props.rows.length })}</p>
      <ul className="onb-checklist">
        {props.rows.map((r) => (
          <li key={r.id} data-done={r.done}>
            <StatusDot tone={r.done ? "ok" : "neutral"} label={t(`onboarding.guide.item.${r.id}`)} />
            <span className="onb-check-state">{t(r.done ? "onboarding.guide.done" : "onboarding.guide.todo")}</span>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

/** The guide as a dialog; mounted by the gate, open when the sidebar entry asks for it. */
export function SetupGuide(props: { api: Api }): JSX.Element | null {
  const { guideOpen } = useOnboarding();
  const rows = useChecklist(props.api);
  if (!guideOpen || !rows) return null;
  return <SetupGuideView rows={rows} onResume={resumeOnboarding} onClose={closeGuide} />;
}
