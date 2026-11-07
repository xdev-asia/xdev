import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api } from "@/api";
import { useI18n } from "@/i18n";
import { copyText } from "@/ui/clipboard";
import { ContextMenu, type MenuItem } from "@/ui/ContextMenu";
import { pushToast } from "@/workspace/toastStore";
import { PLATFORM } from "@/platform";
import { IconButton } from "@xdev-asia/ui";
import { AltViewPane } from "./AltViewPane";
import { CsvView } from "./CsvView";
import { ImageView } from "./ImageView";
import { MarkdownPane } from "./MarkdownPane";
import { MediaView } from "./MediaView";
import { NotebookView } from "./NotebookView";
import { PdfView } from "./PdfView";
import { LoadError } from "./LoadError";
import { CodeEditor, type EditorControls } from "./CodeEditor";
import { clampEditorSettings } from "./editorDefaults";
import { getEditorSettings, setEditorSettings, useEditorSettings } from "./editorSettings";
import { ExternalChange, needsChoice } from "./ExternalChangeBanner";
import { loadFile, saveFile } from "./fileIO";
import { gutterMenuItems, type GutterSelection, type SelectionCapture } from "./gutterMenu";
import { fileTabs, useFileEntry } from "./fileTabs";
import { viewerOf } from "./viewer";
import { useOpenedAsText } from "./viewMode";
import { lineAuthorsPref, useLineAuthorsPref } from "./lineAuthorsPref";
import { useEditorLineAuthors } from "@/review/attribution/useEditorLineAuthors";

/** One open file: reads it when it first shows, then edits it, or says why it cannot. */
export function FileView(props: { api: Api; worktree: string; rel: string; secondary?: boolean }): JSX.Element {
  const { api, worktree, rel } = props;
  const { t } = useI18n();
  const entry = useFileEntry(worktree, rel);
  const settings = useEditorSettings();
  const asText = useOpenedAsText(worktree, rel);
  const status = entry?.status;
  // The gutter's right-click menu: where it opened and for which line.
  const [gutter, setGutter] = useState<{ at: { x: number; y: number }; line: number; selection: GutterSelection | null; capture: SelectionCapture | null } | null>(null);
  // The editor's handle for the toolbar, how many changes it shows, and the more-actions menu.
  const [controls, setControls] = useState<EditorControls | null>(null);
  const [changes, setChanges] = useState(0);
  const [more, setMore] = useState<{ x: number; y: number } | null>(null);
  const io = { api, store: fileTabs, t };
  // Who wrote each line against HEAD, read for the text last read or written; off reads nothing.
  const authorsOn = useLineAuthorsPref();
  const textReady = entry?.status === "ready" && entry.kind === "text";
  const lineAuthors = useEditorLineAuthors(api, worktree, rel, textReady ? entry.saved : undefined, authorsOn && textReady);

  // Word wrap is one setting for every editor: the write returns what was stored, and every open editor follows it.
  async function toggleWrap(): Promise<void> {
    try {
      const stored = await api.editorSettingsPut(clampEditorSettings({ ...getEditorSettings(), wordWrap: !getEditorSettings().wordWrap }));
      setEditorSettings(stored);
    } catch (e) {
      void pushToast({ text: t(`error.${toApiError(e).code}`) });
    }
  }
  const moreItems: MenuItem[] = [
    { id: "wrap", labelKey: "files.menu.wordWrap", chord: "Alt+Z", checked: settings.wordWrap, run: () => void toggleWrap() },
    { id: "lineAuthors", labelKey: "files.menu.lineAuthors", checked: authorsOn, run: () => lineAuthorsPref.set(!authorsOn) },
  ];
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
  } else if (viewer === "pdf") {
    body = <PdfView key={entry?.version ?? 0} api={api} worktree={worktree} rel={rel} />;
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
        <div className="file-toolbar" role="toolbar" aria-label={t("files.toolbar")}>
          <span className="file-path" title={rel}>
            {rel}
          </span>
          <IconButton icon="arrow-up" label={t("files.change.prev")} disabled={changes === 0} onClick={() => controls?.goChange(-1)} />
          <IconButton icon="arrow-down" label={t("files.change.next")} disabled={changes === 0} onClick={() => controls?.goChange(1)} />
          <IconButton
            icon="more"
            label={t("files.more")}
            aria-haspopup="menu"
            onClick={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              setMore({ x: box.left, y: box.bottom });
            }}
          />
        </div>
        <CodeEditor
          worktree={worktree}
          rel={rel}
          secondary={props.secondary}
          value={entry.text}
          settings={settings}
          goto={entry.goto}
          base={entry.saved}
          lineAuthors={lineAuthors}
          onToggleWrap={() => void toggleWrap()}
          onControls={setControls}
          onChangeCount={setChanges}
          onChange={(text) => fileTabs.edit(worktree, rel, text)}
          onSave={() => void saveFile(io, worktree, rel)}
          onGutterMenu={(at, line, selection, capture) => setGutter({ at, line, selection, capture: capture ?? null })}
        />
        {entry.saving && <span className="file-saving" role="status">{t("files.saving")}</span>}
      </>
    );
    if (viewer === "markdown") body = <MarkdownPane api={api} worktree={worktree} rel={rel} text={entry.text} source={editor} />;
    else if (viewer === "csv" || viewer === "notebook") {
      // A read-only view with the code editor behind "Open as text".
      const view = viewer === "csv" ? <CsvView rel={rel} text={entry.text} /> : <NotebookView api={api} worktree={worktree} rel={rel} text={entry.text} />;
      body = <AltViewPane worktree={worktree} rel={rel} label={t(viewer === "csv" ? "files.grid.view" : "files.notebook.view")} asText={asText} view={view} editor={editor} />;
    } else body = editor;
  }
  return (
    <div className="file-view" data-rel={rel} data-kind={entry?.kind}>
      {body}
      {more && <ContextMenu at={more} label={t("files.more")} items={moreItems} onClose={() => setMore(null)} />}
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
