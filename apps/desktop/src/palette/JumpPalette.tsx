import { useEffect, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import { useI18n } from "@/i18n";
import { Highlight } from "./Highlight";
import type { PaletteItem, PaletteKind } from "./items";
import { FILTERS, MORE, rank, type Filter, type Row } from "./rank";
import type { RecentStore } from "./recent";
import "./palette.css";

export interface JumpPaletteProps {
  open: boolean;
  items: PaletteItem[];
  current: { worktree: string | null; tab: string | null };
  recent: RecentStore;
  canCreate: boolean;
  onCreate(name: string): void;
  onClose(): void;
  now?: number;
}

const ICONS: Record<PaletteKind, string> = {
  tab: "M4 5h16v14H4zM8 10l3 2-3 2M13 14h3",
  worktree: "M6 4v10M6 14a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM6 4a2 2 0 1 0 0 .01M18 8a2 2 0 1 0 0 .01M18 10c0 4-6 3-12 4",
  setting: "M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6",
  action: "M13 3 5 13h6l-1 8 8-10h-6z",
};

function KindIcon(props: { kind: PaletteKind }): JSX.Element {
  return (
    <svg className="pal-icon" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={ICONS[props.kind]} />
    </svg>
  );
}

const selectable = (r: Row) => r.type !== "header";

/** The "Jump to…" dialog: a query, a kind filter and the ranked rows. */
export function JumpPalette(props: JumpPaletteProps): JSX.Element {
  const { open, items, current, recent, canCreate, onCreate, onClose } = props;
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState(0);
  const [extra, setExtra] = useState<Partial<Record<Filter, number>>>({});

  // Every opening starts clean.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setFilter("all");
    setSelected(0);
    setExtra({});
  }, [open]);

  const rows = rank({ items, query, filter, current, recent: (id) => recent.at(id), extra, canCreate, now: props.now ?? Date.now() });
  const picks = rows.filter(selectable);
  const at = Math.min(selected, Math.max(0, picks.length - 1));

  function run(row: Row | undefined) {
    if (!row || row.type === "header") return;
    if (row.type === "more") {
      setExtra({ ...extra, [row.section]: (extra[row.section] ?? 0) + MORE });
      return;
    }
    onClose();
    if (row.type === "create") onCreate(row.name);
    else {
      recent.touch(row.item.id);
      row.item.run();
    }
  }

  function byDigit(digit: number): Row | undefined {
    return picks.find((r) => r.type === "item" && r.digit === digit);
  }

  function cycle(by: number) {
    const next = FILTERS[(FILTERS.indexOf(filter) + by + FILTERS.length) % FILTERS.length];
    pickFilter(next);
  }

  function pickFilter(next: Filter) {
    setFilter(next);
    setSelected(0);
    setExtra({});
  }

  function onKeyDown(e: KeyboardEvent) {
    // An Enter that confirms an IME candidate (Telex, CJK) is not a command.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // The search shortcut must not run behind the open palette.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const digit = /^[1-9]$/.test(e.key) ? Number(e.key) : null;
    if (digit !== null && (e.ctrlKey || e.metaKey || query === "")) {
      const row = byDigit(digit);
      if (row) {
        e.preventDefault();
        run(row);
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelected(picks.length ? (at + 1) % picks.length : 0);
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelected(picks.length ? (at - 1 + picks.length) % picks.length : 0);
        break;
      case "Home":
        e.preventDefault();
        setSelected(0);
        break;
      case "End":
        e.preventDefault();
        setSelected(Math.max(0, picks.length - 1));
        break;
      case "Enter":
        e.preventDefault();
        run(picks[at]);
        break;
      case "Tab":
        e.preventDefault();
        cycle(e.shiftKey ? -1 : 1);
        break;
    }
  }

  const selectedRow = picks[at];
  const reveal = (el: HTMLDivElement | null) => el?.scrollIntoView?.({ block: "nearest" });

  return (
    <dialog
      ref={(d) => {
        if (!d) return;
        if (open && !d.open) d.showModal();
        if (!open && d.open) d.close();
      }}
      className="palette"
      aria-labelledby="palette-title"
      onKeyDown={onKeyDown}
      onCancel={(e) => {
        // Escape: close through state, so `open` stays the single source of truth.
        e.preventDefault();
        onClose();
      }}
    >
      <h2 id="palette-title" className="pal-title">
        {t("palette.title")}
      </h2>
      <input
        className="pal-input"
        type="text"
        autoFocus
        spellCheck={false}
        autoComplete="off"
        placeholder={t("palette.placeholder")}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setSelected(0);
          setExtra({});
        }}
      />
      <div className="pal-filters" role="tablist">
        {FILTERS.map((f) => (
          <button key={f} type="button" role="tab" aria-selected={f === filter} className="pal-chip" data-active={f === filter} tabIndex={-1} onClick={() => pickFilter(f)}>
            {t(`palette.filter.${f}`)}
          </button>
        ))}
      </div>
      <div className="pal-list" role="listbox">
        {rows.length === 0 && <p className="pal-empty">{t("palette.empty")}</p>}
        {rows.map((row, i) => {
          if (row.type === "header") {
            return (
              <div key={`h${i}`} className="pal-section">
                {t(`palette.section.${row.label}`)}
              </div>
            );
          }
          const on = row === selectedRow;
          if (row.type === "more") {
            return (
              <div key={`m${row.section}`} role="option" aria-selected={on} ref={on ? reveal : undefined} className="pal-row pal-more" data-selected={on} onClick={() => run(row)}>
                {t("palette.more", { count: row.count })}
              </div>
            );
          }
          if (row.type === "create") {
            return (
              <div key="create" role="option" aria-selected={on} ref={on ? reveal : undefined} className="pal-row" data-selected={on} onClick={() => run(row)}>
                <KindIcon kind="worktree" />
                <span className="pal-title-text">{t("palette.create", { name: row.name })}</span>
              </div>
            );
          }
          const { item } = row;
          return (
            <div key={item.id} role="option" aria-selected={on} ref={on ? reveal : undefined} className="pal-row" data-selected={on} data-kind={item.kind} onClick={() => run(row)}>
              <KindIcon kind={item.kind} />
              <span className="pal-title-text">
                <Highlight text={item.title} hits={row.hits.title} />
              </span>
              {item.detail && (
                <span className="pal-detail">
                  <Highlight text={item.detail} hits={row.hits.detail} />
                </span>
              )}
              {item.status && <span className="pal-dot" data-status={item.status} title={t(`palette.status.${item.status}`)} />}
              {item.hint && <kbd className="pal-key">{item.hint}</kbd>}
              {row.digit !== null && <kbd className="pal-key">{row.digit}</kbd>}
            </div>
          );
        })}
      </div>
      <div className="pal-foot">
        <span>
          <kbd>↑↓</kbd> {t("palette.hint.move")}
        </span>
        <span>
          <kbd>Enter</kbd> {t("palette.hint.open")}
        </span>
        <span>
          <kbd>Tab</kbd> {t("palette.hint.filter")}
        </span>
        <span>
          <kbd>1–9</kbd> {t("palette.hint.pick")}
        </span>
        <span>
          <kbd>Esc</kbd> {t("palette.hint.close")}
        </span>
      </div>
    </dialog>
  );
}
