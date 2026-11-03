import { useState } from "react";
import type { JSX } from "react";
import type { PtyProfile, ReviewNote } from "@/api";
import { profileName, useProfiles } from "@/agents/profileStore";
import { useI18n } from "@/i18n";
import { sendToChosenTab, type SendChoice } from "@/workspace/agentPrompt";
import type { Sessions, Tab } from "@/workspace/sessions";
import { runningAgent as isRunning } from "@/workspace/sendTarget";
import { notesPrompt, notesToSend } from "./notes";


/** Tabs have no name of their own, so a tab reads as its profile name, numbered when several share one. */
function tabLabel(tabs: Tab[], index: number, view: Parameters<typeof profileName>[0], t: Parameters<typeof profileName>[2]): string {
  const name = profileName(view, tabs[index].profileId, t);
  const same = tabs.filter((x) => x.profileId === tabs[index].profileId);
  return same.length > 1 ? `${name} ${same.indexOf(tabs[index]) + 1}` : name;
}

/**
 * "Send N notes": a menu of the running agent tabs of the worktree and a new tab per agent that is
 * on and installed. The notes that were sent are marked once the prompt is typed in.
 */
export function SendNotesMenu(props: {
  sessions: Sessions | null | undefined;
  worktree: string;
  branch: string | null;
  notes: ReviewNote[];
  markSent: (ids: string[]) => Promise<void>;
}): JSX.Element {
  const { sessions, worktree, branch, notes, markSent } = props;
  const { t } = useI18n();
  const { view } = useProfiles();
  const [open, setOpen] = useState(false);
  const [includeSent, setIncludeSent] = useState(false);
  const [state, setState] = useState<"idle" | "sending" | "failed">("idle");

  const list = notesToSend(notes, includeSent);
  const tabs = sessions ? sessions.tabs(worktree).filter(isRunning) : [];
  const fresh: PtyProfile[] = view ? view.profiles.filter((p) => p.profile.enabled && p.installed).map((p) => p.profile.id) : ["claude"];

  async function send(choice: SendChoice): Promise<void> {
    if (!sessions || list.length === 0) return;
    setOpen(false);
    setState("sending");
    try {
      const tab = await sendToChosenTab(sessions, worktree, choice, notesPrompt(branch, list));
      if (tab) await markSent(list.map((n) => n.id));
      setState(tab ? "idle" : "failed");
    } catch {
      setState("failed");
    }
  }

  return (
    <div className="rv-notes rv-send">
      <button
        type="button"
        className="rv-base-button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!sessions || list.length === 0 || state === "sending"}
        onClick={() => setOpen(!open)}
      >
        {t(list.length === 1 ? "review.send.one" : "review.send", { count: list.length })}
      </button>
      {open && (
        <div className="rv-base-menu rv-send-menu" role="menu" aria-label={t("review.send.title")}>
          <label className="rv-check">
            <input type="checkbox" checked={includeSent} onChange={() => setIncludeSent(!includeSent)} />
            <span>{t("review.send.includeSent")}</span>
          </label>
          {tabs.map((tab, i) => (
            <button key={tab.id} type="button" role="menuitem" data-tab={tab.id} onClick={() => void send({ tab: tab.id })}>
              {tabLabel(tabs, i, view, t)}
            </button>
          ))}
          {fresh.map((id) => (
            <button key={id} type="button" role="menuitem" data-new={id} onClick={() => void send({ profile: id })}>
              {t("review.send.newTab", { name: profileName(view, id, t) })}
            </button>
          ))}
        </div>
      )}
      {state === "failed" && (
        <span className="rv-send-failed" role="alert">
          {t("review.send.failed")}
        </span>
      )}
    </div>
  );
}
