import { useEffect } from "react";
import type { JSX } from "react";
import type { Api } from "@/api";
import { useI18n } from "@/i18n";
import { CodeEditor } from "./CodeEditor";
import { useEditorSettings } from "./editorSettings";
import { ExternalChange, needsChoice } from "./ExternalChangeBanner";
import { loadFile, saveFile } from "./fileIO";
import { fileTabs, useFileEntry } from "./fileTabs";

/** One open file: reads it when it first shows, then edits it, or says why it cannot. */
export function FileView(props: { api: Api; worktree: string; rel: string }): JSX.Element {
  const { api, worktree, rel } = props;
  const { t } = useI18n();
  const entry = useFileEntry(worktree, rel);
  const settings = useEditorSettings();
  const status = entry?.status;
  const io = { api, store: fileTabs, t };
  useEffect(() => {
    if (status === "loading") void loadFile({ api, store: fileTabs, t }, worktree, rel);
  }, [api, worktree, rel, status, t]);

  const reveal = (
    <button type="button" className="btn-secondary" onClick={() => void api.fileReveal(worktree, rel).catch(() => undefined)}>
      {t("files.menu.reveal")}
    </button>
  );

  let body: JSX.Element;
  if (!entry || entry.status === "loading") {
    body = <p className="ws-empty">{t("files.loading")}</p>;
  } else if (entry.status === "error") {
    body = <p className="ws-empty">{entry.error === "too_large" ? t("files.tooLarge") : t(`error.${entry.error}`)}</p>;
  } else if (entry.kind === "binary") {
    body = (
      <div className="file-note">
        <p className="ws-empty">{t("files.binary")}</p>
        <p className="file-note-body">{t("files.binary.body")}</p>
        {reveal}
      </div>
    );
  } else if (entry.kind === "tooLarge") {
    body = (
      <div className="file-note">
        <p className="ws-empty">{t("files.tooLarge")}</p>
        <p className="file-note-body">{t("files.tooLarge.body")}</p>
        {reveal}
      </div>
    );
  } else {
    body = (
      <>
        {needsChoice(entry) && <ExternalChange api={api} entry={entry} io={io} />}
        <CodeEditor
          rel={rel}
          value={entry.text}
          settings={settings}
          goto={entry.goto}
          onChange={(text) => fileTabs.edit(worktree, rel, text)}
          onSave={() => void saveFile(io, worktree, rel)}
        />
        {entry.saving && <span className="file-saving" role="status">{t("files.saving")}</span>}
      </>
    );
  }
  return (
    <div className="file-view" data-rel={rel} data-kind={entry?.kind}>
      {body}
    </div>
  );
}
