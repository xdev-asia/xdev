import { Button, Textarea } from "@xdev-asia/ui";
import { useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError, type Issue } from "@/api";
import { useI18n } from "@/i18n";
import { ghReasonText } from "./ghReason";

/** A title and a body for a new issue; Create sends it and hands back the issue, which then opens in the panel. */
export function NewIssueForm(props: { api: Api; repoId: string; onCreated(issue: Issue): void; onCancel(): void }): JSX.Element {
  const { api, repoId } = props;
  const { t } = useI18n();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const blank = title.trim() === "";
  const submit = (): void => {
    if (blank || busy) return;
    setBusy(true);
    setError(null);
    api.issueCreate(repoId, { title: title.trim(), body }).then(
      (issue) => props.onCreated(issue),
      (e: unknown) => {
        setBusy(false);
        setError(toApiError(e));
      },
    );
  };
  return (
    <form
      className="ws-issues"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="ws-fields">
        <label className="ws-field">
          <span>{t("issues.new.title")}</span>
          <input type="text" value={title} maxLength={256} autoFocus disabled={busy} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <Textarea label={t("issues.new.body")} value={body} rows={6} disabled={busy} onChange={(e) => setBody(e.target.value)} />
      </div>
      {error && (
        <p className="error-text" role="alert">
          {ghReasonText(error, t)}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn-secondary" disabled={busy} onClick={props.onCancel}>
          {t("dialog.cancel")}
        </button>
        <Button type="submit" disabled={blank || busy}>
          {t("issues.new.create")}
        </Button>
      </div>
    </form>
  );
}
