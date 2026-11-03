import { Button } from "@xdev/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError, type PrDraft, type PrView } from "../api";
import { useI18n } from "../i18n";

// Mounted only while open, so every opening starts from the given fields.
export function CreatePrDialog(props: {
  api: Api;
  worktree: string;
  initial: PrDraft;
  onCreated(pr: PrView): void;
  onClose(): void;
}): JSX.Element {
  const { api, worktree } = props;
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [base, setBase] = useState(props.initial.base);
  const [title, setTitle] = useState(props.initial.title);
  const [body, setBody] = useState(props.initial.body);
  const [draft, setDraft] = useState(props.initial.draft);
  const [busy, setBusy] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    const d = dialog.current;
    if (d && typeof d.showModal === "function" && !d.open) d.showModal();
  }, []);

  async function agent(): Promise<void> {
    setDrafting(true);
    setError(null);
    try {
      const drafted = await api.worktreeDraftPr(worktree);
      setTitle(drafted.title);
      setBody(drafted.body);
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setDrafting(false);
    }
  }

  async function create(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      props.onCreated(await api.worktreePrCreate(worktree, { base: base.trim(), title: title.trim(), body, draft }));
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setBusy(false);
    }
  }

  const blocked = busy || drafting || title.trim() === "";

  return (
    <dialog
      ref={dialog}
      className="dialog ws-dialog"
      aria-labelledby="ws-pr-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) props.onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!blocked) void create();
        }}
      >
        <h2 id="ws-pr-title" className="dialog-title">
          {t("ship.pr.title")}
        </h2>
        <div className="ws-fields">
          <label className="ws-field">
            <span>{t("ship.pr.base")}</span>
            <input type="text" className="ws-mono" value={base} spellCheck={false} disabled={busy} onChange={(e) => setBase(e.target.value)} />
          </label>
          <label className="ws-field">
            <span>{t("ship.pr.titleField")}</span>
            <input type="text" value={title} autoFocus disabled={busy} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="ws-field">
            <span>{t("ship.pr.body")}</span>
            <textarea rows={6} value={body} disabled={busy} onChange={(e) => setBody(e.target.value)} />
          </label>
          <label className="ws-amend">
            <input type="checkbox" checked={draft} disabled={busy} onChange={() => setDraft((d) => !d)} />
            {t("ship.pr.draft")}
          </label>
        </div>
        {error && (
          <p className="error-text" role="alert">
            {t(`error.${error.code}`)}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn-secondary" disabled={busy || drafting} onClick={() => void agent()}>
            {drafting ? t("ship.pr.agentBusy") : t("ship.pr.agent")}
          </button>
          <button type="button" className="btn-secondary" disabled={busy} onClick={props.onClose}>
            {t("dialog.cancel")}
          </button>
          <Button type="submit" disabled={blocked}>
            {busy ? t("ship.pr.creating") : t("ship.pr.create")}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
