import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { Api } from "@/api";
import { useI18n } from "@/i18n";
import { pushToast } from "@/workspace/toastStore";
import { HandoffDialog } from "./HandoffDialog";
import { MissionControl, tabName } from "./MissionControl";
import type { MentionTab } from "./mentions";
import { onMissionOpen } from "./missionEvents";
import { openTeamCharts } from "./charts/chartEvents";

export interface MissionHostProps {
  api: Api;
  /** Brings tab `id` to the front of its worktree; false when it is not open in this window. */
  focusTab(id: string): boolean;
  /** The terminal tab in front, the sender of a hand-off opened without one. */
  frontTab(): string | null;
}

/** Opens Mission Control and the hand-off dialog when the palette, the activity panel or a row asks. */
export function MissionHost({ api, focusTab, frontTab }: MissionHostProps): JSX.Element | null {
  const { t } = useI18n();
  const [view, setView] = useState<"tabs" | "map" | null>(null);
  const [handoff, setHandoff] = useState<{ from: string | null; tabs: MentionTab[] } | null>(null);

  async function startHandoff(from: string | null): Promise<void> {
    let tabs: MentionTab[] = [];
    try {
      const v = await api.orchestrationMission();
      tabs = v.tabs.filter((x) => x.agent && !x.exited).map((x) => ({ id: x.id, title: tabName(x) }));
    } catch {
      // No list: the dialog says there is no tab to hand off to.
    }
    const sender = from ?? frontTab();
    if (tabs.length < 2) {
      pushToast({ text: t("mission.handoff.noTabs") });
      return;
    }
    setHandoff({ from: sender && tabs.some((x) => x.id === sender) ? sender : null, tabs });
  }

  useEffect(
    () =>
      onMissionOpen((open) => {
        if (open.kind === "mission") setView(open.view);
        else void startHandoff(open.from);
      }),
    [api],
  );

  function focus(id: string): void {
    if (focusTab(id)) {
      setView(null);
      return;
    }
    pushToast({ text: t("mission.focusMissing") });
  }

  return (
    <>
      {view !== null && handoff === null ? (
        <MissionControl api={api} view={view} onView={setView} onClose={() => setView(null)} onFocusTab={focus} onHandoff={(from) => void startHandoff(from)}
          onOpenCharts={(draft) => {
            setView(null);
            openTeamCharts(draft);
          }}
        />
      ) : null}
      {handoff ? (
        <HandoffDialog
          api={api}
          tabs={handoff.tabs}
          from={handoff.from}
          onClose={() => setHandoff(null)}
          onSent={(to) => {
            setHandoff(null);
            pushToast({ text: t("mission.handoff.sent", { name: to }) });
          }}
        />
      ) : null}
    </>
  );
}
