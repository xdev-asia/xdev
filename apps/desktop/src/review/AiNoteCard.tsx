import type { JSX } from "react";
import type { ReviewNote } from "@/api";
import { useI18n } from "@/i18n";
import { aiSeverity } from "./aiFindings";
import { noteLabel } from "./NoteCard";

/** One finding of the AI review under its line: marked AI, with its severity, and Dismiss / Turn into note. */
export function AiNoteCard(props: { note: ReviewNote; onDismiss(): void; onConvert(): void }): JSX.Element {
  const { note } = props;
  const { t } = useI18n();
  const severity = aiSeverity(note);
  return (
    <article className="rv-note rv-note-ai" data-ai="true" data-severity={severity} aria-label={t("review.ai.label")}>
      <header className="rv-note-head">
        <span className="rv-mark rv-mark-ai" title={t("review.ai.markHint")}>
          {t("review.ai.mark")}
        </span>
        <span className="rv-mark rv-mark-severity" data-severity={severity}>
          {t(`review.ai.severity.${severity}`)}
        </span>
        <span className="rv-note-label ws-mono">{noteLabel(note)}</span>
        <span className="rv-note-actions">
          <button type="button" data-act="ai-convert" onClick={props.onConvert}>
            {t("review.ai.convert")}
          </button>
          <button type="button" data-act="ai-dismiss" onClick={props.onDismiss}>
            {t("review.ai.dismiss")}
          </button>
        </span>
      </header>
      <p className="rv-note-body">{note.body}</p>
    </article>
  );
}
