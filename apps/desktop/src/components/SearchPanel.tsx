import type { JSX } from "react";
import type { ApiError, SearchHit } from "../api";
import { useI18n } from "../i18n";
import { renderSnippet } from "./renderSnippet";

export const RESULTS_ID = "search-results";

export function resultId(index: number): string {
  return `${RESULTS_ID}-${index}`;
}

export function SearchPanel(props: {
  query: string;
  hits: SearchHit[];
  searching: boolean;
  error?: ApiError["code"];
  activeIndex: number;
  onOpen(path: string): void;
}): JSX.Element {
  const { t } = useI18n();
  const status = props.error
    ? t(`error.${props.error}`)
    : props.searching
      ? t("search.searching")
      : props.hits.length === 0
        ? t("search.empty", { query: props.query.trim() })
        : t("search.count", { count: props.hits.length });
  return (
    <section className="pane" aria-label={t("search.label")}>
      <div className="pane-head" aria-live="polite">
        <span className={props.error ? "error-text" : undefined}>{status}</span>
      </div>
      <ul className="results" id={RESULTS_ID} role="listbox" aria-label={t("search.label")}>
        {props.hits.map((hit, i) => (
          <li
            key={hit.path}
            id={resultId(i)}
            role="option"
            aria-selected={i === props.activeIndex}
            className="result"
            onClick={() => props.onOpen(hit.path)}
          >
            <span className="result-title">{hit.title}</span>
            <span className="result-path">{hit.path}</span>
            <span className="result-snippet">{renderSnippet(hit.snippet)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
