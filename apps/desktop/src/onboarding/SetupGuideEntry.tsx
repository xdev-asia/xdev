import type { JSX } from "react";
import { api as defaultApi, type Api } from "@/api";
import { useI18n } from "@/i18n";
import { doneCount, isComplete, type Row } from "./checklist";
import { openGuide } from "./onboardingStore";
import { useChecklist } from "./useChecklist";

/** The sidebar footer's "Setup guide" button; nothing once every item is done (or before they are read). */
export function SetupGuideButton(props: { rows: Row[] | null; onOpen(): void }): JSX.Element | null {
  const { t } = useI18n();
  if (!props.rows || isComplete(props.rows)) return null;
  return (
    <button type="button" className="ws-add-repo onb-entry" data-action="setup-guide" onClick={props.onOpen}>
      <span>{t("onboarding.entry")}</span>
      <span className="onb-entry-count">{t("onboarding.guide.progress", { done: doneCount(props.rows), total: props.rows.length })}</span>
    </button>
  );
}

/** `projects` is the sidebar's project count: a new project reads the checklist again. */
export function SetupGuideEntry(props: { api?: Api; projects?: number }): JSX.Element | null {
  const rows = useChecklist(props.api ?? defaultApi, props.projects);
  return <SetupGuideButton rows={rows} onOpen={openGuide} />;
}
