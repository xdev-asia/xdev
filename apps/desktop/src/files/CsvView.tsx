import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import { IconButton, SearchInput } from "@xdev-asia/ui";
import { useI18n } from "@/i18n";
import { delimiterOf, findCells, parseDelimited, toGrid } from "./csv";
import { stepMatch } from "./previewFind";

/** A CSV or TSV file as a read-only grid: a sticky header, the first rows, and find that marks cells. */
export function CsvView(props: { rel: string; text: string }): JSX.Element {
  const { rel, text } = props;
  const { t } = useI18n();
  const grid = useMemo(() => toGrid(parseDelimited(text, delimiterOf(rel))), [text, rel]);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const matches = useMemo(() => findCells(grid, query), [grid, query]);
  const hit = useMemo(() => new Set(matches.map((m) => `${m.row}:${m.col}`)), [matches]);
  const index = Math.min(current, matches.length - 1);
  const at = matches[index];
  const atKey = at ? `${at.row}:${at.col}` : null;

  useEffect(() => {
    if (atKey) host.current?.querySelector(`[data-cell="${atKey}"]`)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [atKey]);

  const step = (dir: 1 | -1): void => setCurrent(Math.max(0, stepMatch(index, matches.length, dir)));
  const close = (): void => {
    setFinding(false);
    setQuery("");
    setCurrent(0);
    host.current?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      setFinding(true);
    } else if (e.key === "Escape" && finding) {
      e.preventDefault();
      close();
    } else if (e.key === "Enter" && finding && (e.target as HTMLElement).tagName === "INPUT") {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    }
  };
  const cls = (row: number, col: number): string | undefined => {
    const k = `${row}:${col}`;
    return k === atKey ? "grid-hit grid-hit-current" : hit.has(k) ? "grid-hit" : undefined;
  };
  const status = query ? (matches.length ? t("files.grid.find.count", { n: index + 1, m: matches.length }) : t("files.grid.find.none")) : "";

  if (grid.columns === 0) return <p className="ws-empty">{t("files.grid.empty")}</p>;
  return (
    <div className="grid-view" ref={host} tabIndex={-1} onKeyDown={onKeyDown}>
      {finding && (
        <div className="md-find" role="search">
          <SearchInput
            size="sm"
            className="md-find-input"
            autoFocus
            value={query}
            placeholder={t("files.grid.find.placeholder")}
            aria-label={t("files.grid.find.label")}
            onChange={(e) => {
              setQuery(e.target.value);
              setCurrent(0);
            }}
            onClear={() => {
              setQuery("");
              setCurrent(0);
            }}
          />
          <span className="md-find-count" aria-live="polite">{status}</span>
          <IconButton icon="arrow-up" label={t("files.grid.find.prev")} disabled={!matches.length} onClick={() => step(-1)} />
          <IconButton icon="arrow-down" label={t("files.grid.find.next")} disabled={!matches.length} onClick={() => step(1)} />
          <IconButton icon="close" label={t("files.grid.find.close")} onClick={close} />
        </div>
      )}
      <div className="grid-scroll">
        <table className="grid-table">
          <thead>
            <tr>
              <th scope="col" className="grid-num" aria-label={t("files.grid.row")} />
              {grid.header.map((h, c) => (
                <th key={c} scope="col" data-cell={`-1:${c}`} className={cls(-1, c)}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((row, r) => (
              <tr key={r}>
                <th scope="row" className="grid-num">{r + 1}</th>
                {row.map((cell, c) => (
                  <td key={c} data-cell={`${r}:${c}`} className={cls(r, c)}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {grid.hidden > 0 && <p className="grid-more" role="status">{t("files.grid.hidden", { n: grid.hidden, shown: grid.rows.length })}</p>}
      </div>
    </div>
  );
}
