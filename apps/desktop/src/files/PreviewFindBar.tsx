import { useEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent, RefObject } from "react";
import { IconButton, SearchInput } from "@xdev-asia/ui";
import { useI18n } from "@/i18n";
import { clearHighlights, highlightMatches, stepMatch } from "./previewFind";

/** Find in the rendered preview: highlights `host`'s text; Enter and Shift+Enter step, Escape closes. */
export function PreviewFindBar(props: { host: RefObject<HTMLElement | null>; html: string; onClose: () => void }): JSX.Element {
  const { host, html, onClose } = props;
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);
  const [count, setCount] = useState(0);
  const bar = useRef<HTMLDivElement>(null);
  const focus = (): void => bar.current?.querySelector("input")?.focus();
  useEffect(focus, []);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    setCount(highlightMatches(el, query, current));
  }, [host, query, current, html]);
  useEffect(() => () => clearHighlights(host.current), [host]);
  const step = (dir: 1 | -1): void => setCurrent(Math.max(0, stepMatch(current, count, dir)));
  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Enter") {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    }
  };
  const status = query ? (count ? t("files.preview.find.count", { n: current + 1, m: count }) : t("files.preview.find.none")) : "";
  return (
    <div className="md-find" role="search" ref={bar} onKeyDown={onKeyDown}>
      <SearchInput
        size="sm"
        className="md-find-input"
        value={query}
        placeholder={t("files.preview.find.placeholder")}
        aria-label={t("files.preview.find.label")}
        onChange={(e) => {
          setQuery(e.target.value);
          setCurrent(0);
        }}
        onClear={() => {
          setQuery("");
          setCurrent(0);
          focus();
        }}
      />
      <span className="md-find-count" aria-live="polite">
        {status}
      </span>
      <IconButton icon="arrow-up" label={t("files.preview.find.prev")} disabled={!count} onClick={() => step(-1)} />
      <IconButton icon="arrow-down" label={t("files.preview.find.next")} disabled={!count} onClick={() => step(1)} />
      <IconButton icon="close" label={t("files.preview.find.close")} onClick={onClose} />
    </div>
  );
}
