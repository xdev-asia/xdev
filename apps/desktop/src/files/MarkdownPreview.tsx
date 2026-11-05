import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX, MouseEvent } from "react";
import type { Api } from "@/api";
import { renderRich, type Heading, type Parsers } from "@/doc/markdownRich";
import { useI18n } from "@/i18n";
import { fillMermaid, mermaidTheme, renderMermaid, type MermaidRender } from "./mermaid";
import { MermaidDialog } from "./MermaidDialog";
import { openFile } from "./openFile";
import { ensureParsers, fenceLanguages } from "./parsers";
import { fillImages, resolveFileLink } from "./previewLinks";

/** Rendered Markdown of `text` (unsaved edits included). Links open files; images read through the backend. */
export function MarkdownPreview(props: { api: Api; worktree: string; rel: string; text: string; onHeadings?: (h: Heading[]) => void; mermaid?: MermaidRender }): JSX.Element {
  const { api, worktree, rel, text, onHeadings, mermaid = renderMermaid } = props;
  const { t } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const [diagram, setDiagram] = useState<string | null>(null);
  const [parsers, setParsers] = useState<Parsers>({});
  useEffect(() => {
    let live = true;
    void ensureParsers(fenceLanguages(text)).then((p) => live && setParsers(p));
    return () => void (live = false);
  }, [text]);
  const rendered = useMemo(
    () =>
      renderRich(text, {
        rel,
        resolve: resolveFileLink,
        parsers,
        labels: {
          frontmatter: t("files.preview.frontmatter"),
          callouts: {
            note: t("files.preview.callout.note"),
            tip: t("files.preview.callout.tip"),
            important: t("files.preview.callout.important"),
            warning: t("files.preview.callout.warning"),
            caution: t("files.preview.callout.caution"),
          },
        },
      }),
    [text, rel, parsers, t],
  );
  useEffect(() => onHeadings?.(rendered.headings), [rendered, onHeadings]);
  useEffect(() => {
    const el = host.current;
    return el ? fillImages(el, { api, worktree, rel }) : undefined;
  }, [rendered.html, api, worktree, rel]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const css = getComputedStyle(document.documentElement);
    return fillMermaid(el, {
      render: mermaid,
      theme: mermaidTheme((name) => css.getPropertyValue(name)),
      labels: { invalid: t("files.preview.mermaid.invalid"), error: (message) => t("files.preview.mermaid.error", { message }), expand: t("files.preview.mermaid.expand") },
    });
  }, [rendered, mermaid, t]);

  // Links never navigate the WebView; only `data-doc` links do anything, and they open a file here.
  const onClick = (e: MouseEvent<HTMLElement>): void => {
    e.preventDefault();
    const expand = e.target instanceof Element ? e.target.closest(".md-mermaid-expand") : null;
    const svg = expand?.parentElement?.querySelector("svg")?.outerHTML;
    if (svg) return setDiagram(svg);
    const link = e.target instanceof Element ? e.target.closest("a[data-doc]") : null;
    const path = link?.getAttribute("data-doc");
    if (path) openFile({ worktree, rel: path });
  };
  return (
    <article className="preview md-preview" onClick={onClick} onAuxClick={(e) => e.preventDefault()}>
      {/* markdown-it output with HTML input disabled, see doc/markdown.ts. */}
      <div className="preview-body" ref={host} dangerouslySetInnerHTML={{ __html: rendered.html }} />
      {diagram !== null && <MermaidDialog svg={diagram} onClose={() => setDiagram(null)} />}
    </article>
  );
}
