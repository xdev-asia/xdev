import { useMemo } from "react";
import type { JSX, MouseEvent } from "react";
import { parseFrontmatter } from "@/doc/frontmatter";
import { createResolver } from "@/doc/links";
import { renderMarkdown } from "@/doc/markdown";
import { useI18n } from "@/i18n";

// Rendered view of the current draft. Links never navigate the WebView: only `data-doc` links do anything,
// and they open the doc inside xDev.
export function Preview(props: { path: string; content: string; docs: string[]; onOpen(path: string): void }): JSX.Element {
  const { t } = useI18n();
  const resolve = useMemo(() => createResolver(props.docs), [props.docs]);
  const { fm, body } = useMemo(() => parseFrontmatter(props.content), [props.content]);
  const html = useMemo(() => renderMarkdown(body, props.path, resolve), [body, props.path, resolve]);

  function onClick(e: MouseEvent<HTMLElement>) {
    e.preventDefault();
    const link = e.target instanceof Element ? e.target.closest("a[data-doc]") : null;
    const path = link?.getAttribute("data-doc");
    if (path) props.onOpen(path);
  }

  const hasProps = fm.title !== null || fm.agents.length > 0 || fm.tags.length > 0;
  return (
    <article className="preview" onClick={onClick} onAuxClick={(e) => e.preventDefault()}>
      {hasProps && (
        <dl className="preview-props">
          {fm.title !== null && (
            <>
              <dt>{t("preview.title")}</dt>
              <dd>{fm.title}</dd>
            </>
          )}
          {fm.agents.length > 0 && (
            <>
              <dt>{t("preview.agents")}</dt>
              <dd className="badges">
                {fm.agents.map((target) => (
                  <span key={target} className="badge">
                    {t(`target.${target}`)}
                  </span>
                ))}
              </dd>
            </>
          )}
          {fm.tags.length > 0 && (
            <>
              <dt>{t("preview.tags")}</dt>
              <dd className="badges">
                {fm.tags.map((tag) => (
                  <span key={tag} className="badge">
                    {tag}
                  </span>
                ))}
              </dd>
            </>
          )}
        </dl>
      )}
      {/* The only raw HTML in the app: markdown-it output with HTML input disabled, see doc/markdown.ts. */}
      <div className="preview-body" dangerouslySetInnerHTML={{ __html: html }} />
    </article>
  );
}
