import MarkdownIt from "markdown-it";
import { useState } from "react";
import { Button, ReviewComment } from "@xdev-asia/ui";
import type { JSX } from "react";
import { toApiError, type ReviewNote } from "@/api";
import { useI18n } from "@/i18n";
import { NoteComposer } from "./NoteComposer";
import type { PostBlock } from "./postable";

// Notes are written by the person but pasted from anywhere: raw HTML is escaped, and a link keeps no
// `href` (nothing in the app opens outside URLs), so the rendered body stays inert.
const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  const href = tokens[idx].attrGet("href") ?? "";
  tokens[idx].attrs = [["data-external", ""], ["title", href]];
  return self.renderToken(tokens, idx, options);
};
md.renderer.rules.image = (tokens, idx, options, env, self) =>
  `<span class="md-image">${md.utils.escapeHtml(self.renderInlineAsText(tokens[idx].children ?? [], options, env))}</span>`;

export const renderNote = (body: string): string => md.render(body);

/** `file:line`, or `file:start–end` for a range. */
export const noteLabel = (note: Pick<ReviewNote, "file" | "startLine" | "line">): string =>
  note.startLine === note.line ? `${note.file}:${note.line}` : `${note.file}:${note.startLine}–${note.line}`;

/** One note under its lines, as a design system review comment: where it is, its body, whether it went out or went stale, and Edit / Delete. */
export function NoteCard(props: {
  note: ReviewNote;
  onEdit(body: string): void;
  onDelete(): void;
  /** Present while the worktree has an open PR: posts the note as an inline comment, rejecting with an ApiError. */
  onPostToPr?(note: ReviewNote): Promise<void>;
  /** Why the note cannot go to the PR yet: the button shows disabled with the reason. */
  postBlocked?: PostBlock | null;
}): JSX.Element {
  const { note } = props;
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [posting, setPosting] = useState(false);
  const [posted, setPosted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(): Promise<void> {
    if (!props.onPostToPr || props.postBlocked || posting) return;
    setPosting(true);
    setError(null);
    try {
      await props.onPostToPr(note);
      setPosted(true);
    } catch (e) {
      const err = toApiError(e);
      setError(`${t(`error.${err.code}`)}${err.code === "gh_failed" && err.detail ? ` ${err.detail}` : ""}`);
    } finally {
      setPosting(false);
    }
  }
  const blocked = props.postBlocked ? (`review.note.postBlocked.${props.postBlocked}` as const) : null;
  if (editing) {
    return (
      <NoteComposer
        label={noteLabel(note)}
        initial={note.body}
        onSave={(body) => {
          setEditing(false);
          props.onEdit(body);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }
  return (
    <ReviewComment
      className="rv-note"
      author={t("review.note.author")}
      // The label is the note's own `file:line`, so it reads the same as in the notes list.
      line={noteLabel(note)}
      labels={{ line: (where) => String(where) }}
      body={<div className="rv-note-body" dangerouslySetInnerHTML={{ __html: renderNote(note.body) }} />}
      footer={
        <>
          <div className="rv-note-head">
            {note.sentAt !== null && <span className="rv-mark rv-mark-sent">{t("review.note.sent")}</span>}
            {note.outdated && (
              <span className="rv-mark rv-mark-outdated" title={t("review.note.outdatedHint")}>
                {t("review.note.outdated")}
              </span>
            )}
            <span className="rv-note-actions">
              {props.onPostToPr && !note.outdated && (
                <Button type="button" size="sm" data-post-pr disabled={posting || posted || !!props.postBlocked} title={blocked ? t(blocked) : undefined} onClick={() => void post()}>
                  {t(posted ? "review.note.posted" : "review.note.postToPr")}
                </Button>
              )}
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(true)}>
                {t("review.note.edit")}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={props.onDelete}>
                {t("review.note.delete")}
              </Button>
            </span>
          </div>
          {blocked && props.onPostToPr && !note.outdated && <p className="ws-empty">{t(blocked)}</p>}
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
        </>
      }
    />
  );
}
