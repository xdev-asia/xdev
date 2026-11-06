import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import type { Api } from "@/api";
import { renderRich, type Parsers } from "@/doc/markdownRich";
import { useI18n } from "@/i18n";
import { MarkdownPreview } from "./MarkdownPreview";
import { fenced, parseNotebook, type NotebookCell, type NotebookOutput } from "./notebook";
import { ensureParsers, fenceLanguages } from "./parsers";
import { resolveFileLink } from "./previewLinks";
import { viewMode } from "./viewMode";

function Output(props: { out: NotebookOutput; alt: string }): JSX.Element {
  const { out } = props;
  if (out.kind === "image") return <img className="nb-image" src={out.url} alt={props.alt} draggable={false} />;
  // Text of every kind, html included, is drawn as text: React escapes it, nothing is parsed as markup.
  return <pre className={out.kind === "error" ? "nb-text nb-error" : out.stream === "stderr" ? "nb-text nb-stderr" : "nb-text"}>{out.text}</pre>;
}

function CodeCell(props: { cell: NotebookCell; language: string; parsers: Parsers; rel: string }): JSX.Element {
  const { t } = useI18n();
  const { cell, language, parsers, rel } = props;
  // A fenced block through the same renderer as the preview: read-only highlighted code.
  const html = useMemo(() => renderRich(fenced(cell.source, language), { rel, resolve: resolveFileLink, parsers }).html, [cell.source, language, parsers, rel]);
  return (
    <div className="nb-cell nb-code" data-cell="code">
      <span className="nb-count" aria-hidden="true">{cell.count === null ? "[ ]" : `[${cell.count}]`}</span>
      <div className="nb-body">
        {/* markdown-it output with HTML input disabled, see doc/markdown.ts. */}
        <div className="preview-body nb-source" dangerouslySetInnerHTML={{ __html: html }} />
        {cell.outputs.map((out, i) => (
          <div key={i} className="nb-output" data-output={out.kind}>
            <Output out={out} alt={t("files.notebook.image")} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A Jupyter notebook, read only: Markdown cells rendered, code cells highlighted, outputs below them. */
export function NotebookView(props: { api: Api; worktree: string; rel: string; text: string }): JSX.Element {
  const { api, worktree, rel, text } = props;
  const { t } = useI18n();
  const parsed = useMemo(() => parseNotebook(text), [text]);
  const language = parsed.ok ? parsed.notebook.language : "python";
  const [parsers, setParsers] = useState<Parsers>({});
  useEffect(() => {
    let live = true;
    void ensureParsers(fenceLanguages(fenced("", language))).then((p) => live && setParsers(p));
    return () => void (live = false);
  }, [language]);

  if (!parsed.ok) {
    return (
      <div className="file-note">
        <p className="ws-empty">{t("files.notebook.error")}</p>
        <p className="file-note-body">{t(parsed.reason === "json" ? "files.notebook.error.json" : "files.notebook.error.shape")}</p>
        <button type="button" className="btn-secondary" onClick={() => viewMode.set(worktree, rel, true)}>{t("files.altView.text")}</button>
      </div>
    );
  }
  const { cells } = parsed.notebook;
  if (cells.length === 0) return <p className="ws-empty">{t("files.notebook.empty")}</p>;
  return (
    <div className="nb-view">
      {cells.map((cell, i) =>
        cell.kind === "markdown" ? (
          <div key={i} className="nb-cell nb-markdown" data-cell="markdown">
            <MarkdownPreview api={api} worktree={worktree} rel={rel} text={cell.source} />
          </div>
        ) : cell.kind === "code" ? (
          <CodeCell key={i} cell={cell} language={language} parsers={parsers} rel={rel} />
        ) : (
          <div key={i} className="nb-cell nb-raw" data-cell="raw">
            <pre className="nb-text">{cell.source}</pre>
          </div>
        ),
      )}
    </div>
  );
}
