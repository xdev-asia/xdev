import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { Api } from "@/api";
import { useI18n } from "@/i18n";
import { copyText } from "@/ui/clipboard";
import { ContextMenu } from "@/ui/ContextMenu";
import { pushToast } from "@/workspace/toastStore";
import { PLATFORM } from "@/platform";
import { Button } from "@xdev-asia/ui";
import { CodeEditor } from "./CodeEditor";
import { useEditorSettings } from "./editorSettings";
import { loadFile, saveFile } from "./fileIO";
import { gutterMenuItems, type GutterSelection } from "./gutterMenu";
import { fileTabs, useFileEntry } from "./fileTabs";

/** One open file: reads it when it first shows, then edits it, or says why it cannot. */
export function FileView(props: { api: Api; worktree: string; rel: string }): JSX.Element {
  const { api, worktree, rel } = props;
  const { t } = useI18n();
  const entry = useFileEntry(worktree, rel);
  const settings = useEditorSettings();
  const status = entry?.status;
  // The gutter's right-click menu: where it opened and for which line.
  const [gutter, setGutter] = useState<{ at: { x: number; y: number }; line: number; selection: GutterSelection | null } | null>(null);
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
        {entry.conflict !== null && (
          <div className="file-conflict" role="alert">
            <span>{t("files.conflict.body")}</span>
            <button type="button" className="btn-secondary" onClick={() => void loadFile(io, worktree, rel)}>
              {t("files.conflict.reload")}
            </button>
            <Button type="button" onClick={() => void saveFile(io, worktree, rel, true)}>{t("files.conflict.overwrite")}</Button>
          </div>
        )}
        <CodeEditor
          rel={rel}
          value={entry.text}
          settings={settings}
          goto={entry.goto}
          onChange={(text) => fileTabs.edit(worktree, rel, text)}
          onSave={() => void saveFile(io, worktree, rel)}
          onGutterMenu={(at, line, selection) => setGutter({ at, line, selection })}
        />
        {entry.saving && <span className="file-saving" role="status">{t("files.saving")}</span>}
      </>
    );
  }
  return (
    <div className="file-view" data-rel={rel} data-kind={entry?.kind}>
      {body}
      {gutter && (
        <ContextMenu
          at={gutter.at}
          label={t("editor.gutter.label")}
          items={gutterMenuItems({ api, worktree, rel, line: gutter.line, selection: gutter.selection, copyText, toast: (text) => void pushToast({ text }), t, win: PLATFORM === "win" })}
          onClose={() => setGutter(null)}
        />
      )}
    </div>
  );
}
