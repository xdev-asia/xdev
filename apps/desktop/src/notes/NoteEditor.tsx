import { Button, Dialog, Textarea } from "@xdev-asia/ui";
import { useState } from "react";
import type { JSX } from "react";
import { toApiError, type Note } from "@/api";
import { useI18n } from "@/i18n";
import { renderNote } from "@/review/NoteCard";
import { byteLength, NOTE_BODY_MAX, tooLong } from "./noteModel";
import type { NotesStore } from "./notesStore";

/** What a note belongs to: its tab, and the labels kept beside the text. */
export interface NoteTarget {
  tab: string;
  worktree: string;
  title: string;
}

/**
 * The sticky note of one tab, in a modal dialog: Markdown text with a preview, Save (the one primary
 * button), and Send to agent, Delete note and All notes as secondary buttons.
 */
export function NoteEditor(props: {
  store: NotesStore;
  target: NoteTarget;
  note: Note | null;
  onClose: () => void;
  /** Types the text into the tab's terminal; absent hides Send to agent (the tab is gone). */
  onSend?: (body: string) => Promise<void>;
  onLibrary?: () => void;
}): JSX.Element {
  const { store, target, note } = props;
  const { t } = useI18n();
  const [body, setBody] = useState(note?.body ?? "");
  const [failed, setFailed] = useState(false);
  const over = tooLong(body);
  const blank = body.trim() === "";

  const save = async () => {
    try {
      await store.save({ ...target, body, updatedAt: 0 });
      props.onClose();
    } catch (e) {
      setFailed(toApiError(e).code !== "bad_note" || !over);
    }
  };
  const remove = async () => {
    try {
      await store.remove(target.tab);
      props.onClose();
    } catch {
      setFailed(true);
    }
  };

  return (
    <Dialog
      modal
      title={t("notes.title", { name: target.title })}
      confirmLabel={t("notes.save")}
      cancelLabel={t("notes.cancel")}
      confirmDisabled={over}
      onConfirm={() => void save()}
      onCancel={props.onClose}
    >
      <div className="note-editor">
        <Textarea
          label={t("notes.field")}
          mono
          rows={8}
          value={body}
          placeholder={t("notes.placeholder")}
          onChange={(e) => {
            setBody(e.target.value);
            setFailed(false);
          }}
          error={over ? t("notes.tooLong") : failed ? t("notes.saveFailed") : undefined}
          hint={t("notes.size", { used: (byteLength(body) / 1024).toFixed(1), max: NOTE_BODY_MAX / 1024 })}
        />
        {!blank && <div className="note-preview rv-note-body" role="region" aria-label={t("notes.preview")} dangerouslySetInnerHTML={{ __html: renderNote(body) }} />}
        <div className="note-editor-actions">
          {props.onSend && (
            <Button variant="secondary" disabled={blank} onClick={() => void props.onSend?.(body)}>
              {t("notes.send")}
            </Button>
          )}
          {note && (
            <Button variant="secondary" onClick={() => void remove()}>
              {t("notes.delete")}
            </Button>
          )}
          {props.onLibrary && (
            <Button variant="secondary" onClick={props.onLibrary}>
              {t("notes.library.open")}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
