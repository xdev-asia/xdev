import type { JSX } from "react";
import type { Heading } from "@/doc/markdownRich";
import { useI18n } from "@/i18n";
import { tocOf } from "./tocModel";

/** The headings of a preview, h1 to h3, indented by level; a click asks for that heading. */
export function Toc(props: { headings: readonly Heading[]; onPick: (id: string) => void }): JSX.Element {
  const { t } = useI18n();
  const items = tocOf(props.headings);
  return (
    <nav className="md-toc" aria-label={t("files.preview.toc")}>
      {items.length === 0 ? (
        <p className="md-toc-empty">{t("files.preview.noHeadings")}</p>
      ) : (
        <ul>
          {items.map((h) => (
            <li key={h.id} data-level={h.level}>
              <button type="button" className="md-toc-item" onClick={() => props.onPick(h.id)}>
                {h.text}
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
