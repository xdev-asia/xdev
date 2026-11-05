import type { JSX, ReactNode } from "react";
import type { PtyProfile } from "@/api";
import { profileName, useProfiles } from "@/agents/profileStore";
import { useI18n } from "@/i18n";
import type { SendChoice } from "./agentPrompt";
import type { Sessions, Tab } from "./sessions";
import { runningAgent as isRunning } from "./sendTarget";

/** Tabs have no name of their own, so a tab reads as its profile name, numbered when several share one. */
function tabLabel(tabs: Tab[], index: number, view: Parameters<typeof profileName>[0], t: Parameters<typeof profileName>[2]): string {
  const name = profileName(view, tabs[index].profileId, t);
  const same = tabs.filter((x) => x.profileId === tabs[index].profileId);
  return same.length > 1 ? `${name} ${same.indexOf(tabs[index]) + 1}` : name;
}

type View = Parameters<typeof profileName>[0];
type Translate = Parameters<typeof profileName>[2];

/** The buttons that say where a prompt goes: each running agent tab, then a new tab per agent that is on and installed. */
export function targetItems(
  sessions: Sessions | null | undefined,
  worktree: string,
  view: View,
  t: Translate & ((key: string, vars?: Record<string, string | number>) => string),
  onChoose: (choice: SendChoice) => void,
): JSX.Element[] {
  const tabs = sessions ? sessions.tabs(worktree).filter(isRunning) : [];
  const fresh: PtyProfile[] = view ? view.profiles.filter((p) => p.profile.enabled && p.installed).map((p) => p.profile.id) : ["claude"];
  return [
    ...tabs.map((tab, i) => (
      <button key={tab.id} type="button" role="menuitem" data-tab={tab.id} onClick={() => onChoose({ tab: tab.id })}>
        {tabLabel(tabs, i, view, t)}
      </button>
    )),
    ...fresh.map((id) => (
      <button key={id} type="button" role="menuitem" data-new={id} onClick={() => onChoose({ profile: id })}>
        {t("review.send.newTab", { name: profileName(view, id, t) })}
      </button>
    )),
  ];
}

/** `targetItems` in its own menu; `children` sit above the list (an option for the send). */
export function AgentTargetMenu(props: {
  sessions: Sessions | null | undefined;
  worktree: string;
  title: string;
  className?: string;
  onChoose: (choice: SendChoice) => void;
  children?: ReactNode;
}): JSX.Element {
  const { t } = useI18n();
  const { view } = useProfiles();
  return (
    <div className={`rv-base-menu ${props.className ?? "rv-send-menu"}`} role="menu" aria-label={props.title}>
      {props.children}
      {targetItems(props.sessions, props.worktree, view, t, props.onChoose)}
    </div>
  );
}
