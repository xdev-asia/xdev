import { Dialog, IconButton, SearchInput } from "@xdev-asia/ui";
import { useMemo, useState } from "react";
import type { JSX } from "react";
import type { Note } from "@/api";
import { useI18n } from "@/i18n";
import { searchNotes, snippet } from "./noteModel";

/** One row: the note opens on click; Send needs its tab to be open; Delete removes it. No hooks. */
export function NoteRow(props: {
  note: Note;
  live: boolean;
  when: (ms: number) => string;
  onEdit: (note: Note) => void;
  onSend: (note: Note) => void;
  onDelete: (note: Note) => void;
}): JSX.Element {
  const { t } = useI18n();
  const { note: n, live } = props;
  return (
    <li className="note-library-row" data-tab={n.tab}>
      <button type="button" className="note-library-main" aria-label={t("notes.library.edit", { name: n.title })} onClick={() => props.onEdit(n)}>
        <span className="note-library-title">{n.title}</span>
        <span className="note-library-snippet">{snippet(n.body)}</span>
        <span className="note-library-meta">
          {n.worktree} · {props.when(n.updatedAt)}
          {live ? "" : ` · ${t("notes.library.closed")}`}
        </span>
      </button>
      <IconButton icon="send" label={t("notes.library.send", { name: n.title })} disabled={!live} onClick={() => props.onSend(n)} />
      <IconButton icon="trash" label={t("notes.library.delete", { name: n.title })} onClick={() => props.onDelete(n)} />
    </li>
  );
}

/** All notes: search, then edit, send or delete one. The primary button only closes the dialog. */
export function NotesLibrary(props: {
  notes: readonly Note[];
  /** The tab ids that are open now: only their notes can be sent. */
  liveTabs: ReadonlySet<string>;
  onEdit: (note: Note) => void;
  onSend: (note: Note) => void;
  onDelete: (note: Note) => void;
  onClose: () => void;
}): JSX.Element {
  const { t, locale } = useI18n();
  const [query, setQuery] = useState("");
  const shown = useMemo(() => searchNotes(props.notes, query), [props.notes, query]);
  const when = (ms: number) => new Date(ms).toLocaleString(locale, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  return (
    <Dialog modal size="wide" title={t("notes.library.title")} confirmLabel={t("notes.library.close")} cancelLabel={null} onConfirm={props.onClose} onCancel={props.onClose}>
      <div className="note-library">
        <SearchInput
          size="sm"
          aria-label={t("notes.library.search")}
          placeholder={t("notes.library.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onClear={() => setQuery("")}
          count={query.trim() ? shown.length : undefined}
        />
        {shown.length === 0 ? (
          <p className="dialog-body">{props.notes.length === 0 ? t("notes.library.empty") : t("notes.library.noMatch")}</p>
        ) : (
          <ul className="note-library-list" aria-label={t("notes.library.list")}>
            {shown.map((n) => (
              <NoteRow key={n.tab} note={n} live={props.liveTabs.has(n.tab)} when={when} onEdit={props.onEdit} onSend={props.onSend} onDelete={props.onDelete} />
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

