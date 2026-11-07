import { useState } from "react";
import type { JSX } from "react";
import { Button, Checkbox } from "@xdev-asia/ui";
import type { ReviewNote } from "@/api";
import { useI18n } from "@/i18n";
import { sendToChosenTab, type SendChoice } from "@/workspace/agentPrompt";
import { targetItems } from "@/workspace/AgentTargetMenu";
import { useProfiles } from "@/agents/profileStore";
import type { Sessions } from "@/workspace/sessions";
import { notesToSend, reviewPrompt, type Verdict } from "./notes";

/**
 * "Send N notes": a menu of the running agent tabs of the worktree and a new tab per agent that is
 * on and installed. The notes that were sent are marked once the prompt is typed in. With `review` it is the
 * verdict panel's primary "Send review": the verdict and summary lead the prompt, and it may go with no note.
 */
export function SendNotesMenu(props: {
  sessions: Sessions | null | undefined;
  worktree: string;
  branch: string | null;
  notes: ReviewNote[];
  markSent: (ids: string[]) => Promise<void>;
  review?: { verdict: Verdict; summary: string; onSent(): void };
}): JSX.Element {
  const { sessions, worktree, branch, notes, markSent, review } = props;
  const { t } = useI18n();
  const { view } = useProfiles();
  const [open, setOpen] = useState(false);
  const [includeSent, setIncludeSent] = useState(false);
  const [state, setState] = useState<"idle" | "sending" | "failed">("idle");

  const list = notesToSend(notes, includeSent);
  // A review says something even without a note: a summary, or an approval.
  const empty = list.length === 0 && (!review || (review.verdict !== "approve" && !review.summary.trim()));

  async function send(choice: SendChoice): Promise<void> {
    if (!sessions || empty) return;
    setOpen(false);
    setState("sending");
    try {
      const tab = await sendToChosenTab(sessions, worktree, choice, reviewPrompt(branch, list, review?.verdict ?? "changes", review?.summary ?? ""));
      if (tab && list.length > 0) await markSent(list.map((n) => n.id));
      if (tab) review?.onSent();
      setState(tab ? "idle" : "failed");
    } catch {
      setState("failed");
    }
  }

  return (
    <div className="rv-notes rv-send">
      <Button
        type="button"
        size="sm"
        variant={review ? "primary" : "secondary"}
        className="rv-base-button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!sessions || empty || state === "sending"}
        onClick={() => setOpen(!open)}
      >
        {review ? t("review.verdict.send") : t(list.length === 1 ? "review.send.one" : "review.send", { count: list.length })}
      </Button>
      {open && (
        <div className="rv-base-menu rv-send-menu" role="menu" aria-label={t("review.send.title")}>
          <Checkbox className="rv-check" label={t("review.send.includeSent")} checked={includeSent} onChange={() => setIncludeSent(!includeSent)} />
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
