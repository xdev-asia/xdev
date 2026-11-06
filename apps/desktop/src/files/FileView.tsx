import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { Api } from "@/api";
import { useI18n } from "@/i18n";
import { copyText } from "@/ui/clipboard";
import { ContextMenu } from "@/ui/ContextMenu";
import { pushToast } from "@/workspace/toastStore";
import { PLATFORM } from "@/platform";
import { Button } from "@xdev-asia/ui";
import { ImageView } from "./ImageView";
import { MarkdownPane } from "./MarkdownPane";
import { MediaView } from "./MediaView";
import { LoadError } from "./LoadError";
import { CodeEditor } from "./CodeEditor";
import { useEditorSettings } from "./editorSettings";
import { ExternalChange, needsChoice } from "./ExternalChangeBanner";
import { loadFile, saveFile } from "./fileIO";
import { gutterMenuItems, type GutterSelection, type SelectionCapture } from "./gutterMenu";
import { fileTabs, useFileEntry } from "./fileTabs";
import { viewerOf } from "./viewer";

/** One open file: reads it when it first shows, then edits it, or says why it cannot. */
export function FileView(props: { api: Api; worktree: string; rel: string; secondary?: boolean }): JSX.Element {
  const { api, worktree, rel } = props;
  const { t } = useI18n();
  const entry = useFileEntry(worktree, rel);
  const settings = useEditorSettings();
  const status = entry?.status;
  // The gutter's right-click menu: where it opened and for which line.
  const [gutter, setGutter] = useState<{ at: { x: number; y: number }; line: number; selection: GutterSelection | null; capture: SelectionCapture | null } | null>(null);
  const io = { api, store: fileTabs, t };
  // Images and media are read as bytes by their own view, so the text read is skipped for them.
  const direct = viewerOf(rel) !== "text" && viewerOf(rel) !== "markdown";
  useEffect(() => {
    if (!direct && status === "loading") void loadFile({ api, store: fileTabs, t }, worktree, rel);
  }, [api, worktree, rel, status, t, direct]);

  const reveal = (
    <button type="button" className="btn-secondary" onClick={() => void api.fileReveal(worktree, rel).catch(() => undefined)}>
      {t("files.menu.reveal")}
    </button>
  );

  const viewer = direct ? viewerOf(rel) : entry?.status === "ready" ? viewerOf(rel, entry.kind) : "text";
  let body: JSX.Element;
  if (direct && (entry?.external === "deleted" || entry?.external === "renamed")) {
    // The watcher saw the file go: say so, and let Retry look again.
    body = (
      <LoadError
        code="not_found"
        onRetry={() => fileTabs.markExternal(worktree, rel, null)}
        onReveal={() => void api.fileReveal(worktree, rel).catch(() => undefined)}
      />
    );
  } else if (viewer === "image") {
    body = <ImageView key={entry?.version ?? 0} api={api} worktree={worktree} rel={rel} />;
  } else if (viewer === "media") {
    body = <MediaView key={entry?.version ?? 0} api={api} worktree={worktree} rel={rel} />;
  } else if (!entry || entry.status === "loading") {
    body = <p className="ws-empty">{t("files.loading")}</p>;
  } else if (entry.status === "error") {
    const failed = entry.error ?? "io";
    body =
      failed === "too_large" ? (
        <div className="file-note">
          <p className="ws-empty">{t("files.tooLarge")}</p>
          <p className="file-note-body">{t("files.tooLarge.body")}</p>
          {reveal}
        </div>
      ) : (
        <LoadError
          code={failed}
          onRetry={() => void loadFile(io, worktree, rel)}
          onReveal={() => void api.fileReveal(worktree, rel).catch(() => undefined)}
        />
      );
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
    const editor = (
      <>
        {needsChoice(entry) && <ExternalChange api={api} entry={entry} io={io} />}
        <CodeEditor
          worktree={worktree}
          rel={rel}
          secondary={props.secondary}
          value={entry.text}
          settings={settings}
          goto={entry.goto}
          onChange={(text) => fileTabs.edit(worktree, rel, text)}
          onSave={() => void saveFile(io, worktree, rel)}
          onGutterMenu={(at, line, selection, capture) => setGutter({ at, line, selection, capture: capture ?? null })}
        />
        {entry.saving && <span className="file-saving" role="status">{t("files.saving")}</span>}
      </>
    );
    body = viewer === "markdown" ? <MarkdownPane api={api} worktree={worktree} rel={rel} text={entry.text} source={editor} /> : editor;
  }
  return (
    <div className="file-view" data-rel={rel} data-kind={entry?.kind}>
      {body}
      {gutter && (
        <ContextMenu
          at={gutter.at}
          label={t("editor.gutter.label")}
          items={gutterMenuItems({ api, worktree, rel, line: gutter.line, selection: gutter.selection, capture: gutter.capture, copyText, toast: (text) => void pushToast({ text }), t, win: PLATFORM === "win" })}
          onClose={() => setGutter(null)}
        />
      )}
    </div>
  );
}
