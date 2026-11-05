import { useState } from "react";
import type { JSX } from "react";
import type { ReviewNote } from "@/api";
import { useI18n } from "@/i18n";
import { sendToChosenTab, type SendChoice } from "@/workspace/agentPrompt";
import { targetItems } from "@/workspace/AgentTargetMenu";
import { useProfiles } from "@/agents/profileStore";
import type { Sessions } from "@/workspace/sessions";
import { notesPrompt, notesToSend } from "./notes";


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
          {targetItems(sessions, worktree, view, t, (choice) => void send(choice))}
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
