import { Button, Segmented } from "@xdev-asia/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError } from "@/api";
import { renderMarkdown } from "@/doc/markdown";
import { useI18n } from "@/i18n";

const NO_LINKS = () => null;
// As the backend: 1 to 256 chars of title.
const TITLE_MAX = 256;

type View = "write" | "preview";

// Mounted only while open, so every opening starts from the pull request as it is.
export function EditPrDialog(props: {
  api: Api;
  worktree: string;
  number: number;
  title: string;
  body: string;
  onSaved(): void | Promise<void>;
  onClose(): void;
}): JSX.Element {
  const { api, worktree, number } = props;
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(props.title);
  const [body, setBody] = useState(props.body);
  const [view, setView] = useState<View>("write");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    const d = dialog.current;
    if (d && typeof d.showModal === "function" && !d.open) d.showModal();
  }, []);

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.worktreePrEdit(worktree, number, title.trim(), body);
      await props.onSaved();
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setBusy(false);
    }
  }

  const trimmed = title.trim();
  const blocked = busy || trimmed === "" || [...trimmed].length > TITLE_MAX;

  return (
    <dialog
      ref={dialog}
      className="dialog ws-dialog pr-edit"
      aria-labelledby="pr-edit-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) props.onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!blocked) void save();
        }}
      >
        <h2 id="pr-edit-title" className="dialog-title">
          {t("prPanel.edit.title", { number })}
        </h2>
        <div className="ws-fields">
          <label className="ws-field">
            <span>{t("prPanel.edit.titleField")}</span>
            <input type="text" value={title} autoFocus disabled={busy} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <div className="ws-field">
            <div className="pr-edit-bar">
              <span id="pr-edit-body">{t("prPanel.edit.body")}</span>
              <Segmented
                label={t("prPanel.edit.view")}
                value={view}
                onChange={(v) => setView(v as View)}
                options={[
                  { value: "write", label: t("prPanel.edit.write") },
                  { value: "preview", label: t("prPanel.edit.preview") },
                ]}
              />
            </div>
            {view === "write" ? (
              <textarea aria-labelledby="pr-edit-body" rows={10} value={body} disabled={busy} onChange={(e) => setBody(e.target.value)} />
            ) : body.trim() === "" ? (
              <p className="ws-empty">{t("prPanel.noBody")}</p>
            ) : (
              <div className="preview-body pr-body pr-edit-preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(body, "", NO_LINKS) }} />
            )}
          </div>
        </div>
        {error && (
          <p className="error-text" role="alert">
            {t(`error.${error.code}`)}
            {error.code === "gh_failed" && error.detail ? ` ${error.detail}` : ""}
          </p>
        )}
        <div className="dialog-actions">
          <Button type="button" variant="secondary" disabled={busy} onClick={props.onClose}>
            {t("dialog.cancel")}
          </Button>
          <Button type="submit" disabled={blocked}>
            {busy ? t("prPanel.edit.saving") : t("prPanel.edit.save")}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
