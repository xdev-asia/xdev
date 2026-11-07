import { useState } from "react";
import type { JSX } from "react";
import { Button } from "@xdev-asia/ui";
import { MAX_BODY } from "./notes";
import { useI18n } from "@/i18n";

/** A textarea for one note: Ctrl+Enter saves, Esc cancels, and an empty note cannot be saved. */
export function NoteComposer(props: { label: string; initial?: string; onSave(body: string): void; onCancel(): void }): JSX.Element {
  const { t } = useI18n();
  const [body, setBody] = useState(props.initial ?? "");
  const empty = body.trim() === "";
  const save = () => {
    if (!empty) props.onSave(body.trim());
  };
  return (
    <div className="rv-composer">
      <span className="rv-note-label ws-mono">{props.label}</span>
      <textarea
        autoFocus
        rows={3}
        value={body}
        maxLength={MAX_BODY}
        placeholder={t("review.note.placeholder")}
        aria-label={t("review.note.placeholder")}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          // The editor under this widget has keys of its own (`c`); typing here must not reach them.
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            props.onCancel();
          } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            save();
          }
        }}
      />
      <div className="rv-composer-actions">
        <Button type="button" variant="primary" size="sm" disabled={empty} onClick={save}>
          {t("review.note.save")}
        </Button>
        <Button type="button" size="sm" onClick={props.onCancel}>
          {t("review.note.cancel")}
        </Button>
      </div>
    </div>
  );
}
