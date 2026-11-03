import { Button } from "@xdev/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { ApiError, RepoView } from "@/api";
import { useI18n } from "@/i18n";

// Mounted only while open, so every opening starts from blank fields.
export function CreateWorktreeDialog(props: {
  repos: RepoView[];
  repoId: string;
  busy: boolean;
  error?: ApiError["code"];
  /** A name to start with, such as one typed into the jump palette. */
  name?: string;
  onCreate(repoId: string, name: string, from: string | null): void;
  onCancel(): void;
}): JSX.Element {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [repoId, setRepoId] = useState(props.repoId);
  const [name, setName] = useState(props.name ?? "");
  const [from, setFrom] = useState("");

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);

  // A repo whose folder is gone cannot take a new worktree.
  const choices = props.repos.filter((r) => !r.missing);
  const repo = choices.find((r) => r.id === repoId) ?? choices[0];
  const error =
    props.error === undefined ? undefined : props.error === "bad_name" ? t("workspace.create.badName") : t(`error.${props.error}`);

  return (
    <dialog
      ref={dialog}
      className="dialog ws-dialog"
      aria-labelledby="ws-create-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!props.busy) props.onCancel();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (repo && !props.busy) props.onCreate(repo.id, name.trim(), from.trim() || null);
        }}
      >
        <h2 id="ws-create-title" className="dialog-title">
          {t("workspace.create.title")}
        </h2>
        <p className="dialog-body">{t("workspace.create.body")}</p>
        <div className="ws-fields">
          <label className="ws-field">
            <span>{t("workspace.create.repo")}</span>
            <select value={repo?.id ?? ""} disabled={props.busy} onChange={(e) => setRepoId(e.target.value)}>
              {choices.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.shortName}
                </option>
              ))}
            </select>
          </label>
          <label className="ws-field">
            <span>{t("workspace.create.name")}</span>
            <input
              type="text"
              value={name}
              placeholder={t("workspace.create.namePlaceholder")}
              spellCheck={false}
              autoFocus
              disabled={props.busy}
              aria-describedby="ws-create-hint"
              onChange={(e) => setName(e.target.value)}
            />
            <small id="ws-create-hint">{t("workspace.create.nameHint")}</small>
          </label>
          <label className="ws-field">
            <span>{t("workspace.create.from")}</span>
            <input
              type="text"
              className="ws-mono"
              value={from}
              placeholder={repo?.baseRef ?? ""}
              spellCheck={false}
              disabled={props.busy}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
        </div>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn-secondary" disabled={props.busy} onClick={props.onCancel}>
            {t("dialog.cancel")}
          </button>
          <Button type="submit" disabled={!repo || props.busy}>
            {props.busy ? t("workspace.create.busy") : t("workspace.create.confirm")}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
