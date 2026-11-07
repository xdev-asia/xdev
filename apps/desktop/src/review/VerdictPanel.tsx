import { useState } from "react";
import type { JSX } from "react";
import { RadioGroup, Textarea } from "@xdev-asia/ui";
import type { ReviewNote } from "@/api";
import { useI18n } from "@/i18n";
import type { Sessions } from "@/workspace/sessions";
import { notesToSend, type Verdict } from "./notes";
import { SendNotesMenu } from "./SendNotesMenu";

const VERDICTS: readonly Verdict[] = ["changes", "comment", "approve"];

/**
 * The end of a review: a verdict, a summary, and "Send review", the view's one primary, which hands the
 * verdict, the summary and the notes not sent yet to an agent tab of the worktree.
 */
export function VerdictPanel(props: {
  sessions: Sessions | null | undefined;
  worktree: string;
  branch: string | null;
  notes: ReviewNote[];
  markSent: (ids: string[]) => Promise<void>;
}): JSX.Element {
  const { t } = useI18n();
  const [verdict, setVerdict] = useState<Verdict>("changes");
  const [summary, setSummary] = useState("");
  const count = notesToSend(props.notes, false).length;
  return (
    <section className="rv-verdict" aria-label={t("review.verdict.region")}>
      <RadioGroup
        name={`rv-verdict-${props.worktree}`}
        orientation="vertical"
        label={t("review.verdict")}
        value={verdict}
        onChange={(v) => setVerdict(v as Verdict)}
        options={VERDICTS.map((v) => ({ value: v, label: t(`review.verdict.${v}`), hint: t(`review.verdict.${v}.hint`) }))}
      />
      <Textarea
        label={t("review.verdict.summary")}
        placeholder={t("review.verdict.summaryPlaceholder")}
        rows={3}
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
      />
      <p className="rv-verdict-count">{t("review.verdict.notes", { count })}</p>
      <SendNotesMenu
        sessions={props.sessions}
        worktree={props.worktree}
        branch={props.branch}
        notes={props.notes}
        markSent={props.markSent}
        review={{ verdict, summary, onSent: () => setSummary("") }}
      />
    </section>
  );
}
