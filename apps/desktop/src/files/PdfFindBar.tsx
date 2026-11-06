import { useEffect, useRef } from "react";
import type { JSX, KeyboardEvent } from "react";
import { IconButton, SearchInput } from "@xdev-asia/ui";
import { useI18n } from "@/i18n";

/** Enter steps forward, Shift+Enter back, Escape closes; true when the key was one of them. */
export function findKey(
  e: Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault" | "stopPropagation">,
  on: { onStep: (dir: 1 | -1) => void; onClose: () => void },
): boolean {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    on.onClose();
    return true;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    on.onStep(e.shiftKey ? -1 : 1);
    return true;
  }
  return false;
}

export interface PdfFindBarProps {
  /** The query the session is searching for. */
  query: string;
  /** Matches found so far. */
  count: number;
  /** Index of the current match; shown 1-based. */
  current: number;
  /** Set while pages are still being read: how many of how many. */
  searching: { n: number; m: number } | null;
  onQuery: (query: string) => void;
  onStep: (dir: 1 | -1) => void;
  onClose: () => void;
}

/** Find in a PDF: the query goes to the session, which reads every page; the count covers the whole document. Controlled: the session owns the query. */
export function PdfFindBar(props: PdfFindBarProps): JSX.Element {
  const { query, count, current, searching, onQuery, onStep, onClose } = props;
  const { t } = useI18n();
  const bar = useRef<HTMLDivElement>(null);
  const focus = (): void => bar.current?.querySelector("input")?.focus();
  useEffect(focus, []);
  const status = !query
    ? ""
    : searching
      ? t("files.pdf.find.searching", { n: searching.n, m: searching.m })
      : count
        ? t("files.preview.find.count", { n: current + 1, m: count })
        : t("files.preview.find.none");
  return (
    <div className="md-find" role="search" ref={bar} onKeyDown={(e) => void findKey(e, { onStep, onClose })}>
      <SearchInput
        size="sm"
        className="md-find-input"
        value={query}
        placeholder={t("files.pdf.find")}
        aria-label={t("files.pdf.find")}
        onChange={(e) => onQuery(e.target.value)}
        onClear={() => {
          onQuery("");
          focus();
        }}
      />
      <span className="md-find-count" aria-live="polite">
        {status}
      </span>
      <IconButton icon="arrow-up" label={t("files.preview.find.prev")} disabled={!count} onClick={() => onStep(-1)} />
      <IconButton icon="arrow-down" label={t("files.preview.find.next")} disabled={!count} onClick={() => onStep(1)} />
      <IconButton icon="close" label={t("files.preview.find.close")} onClick={onClose} />
    </div>
  );
}
