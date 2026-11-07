import { Icon, type IconName } from "@xdev-asia/ui";
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
  /** The projects the Filter button offers; none hides the button. */
  scopes?: { path: string; name: string }[];
  /** Items that depend on the query, such as the files it matches; added to `items`. */
  queryItems?: (query: string) => PaletteItem[];
  now?: number;
}

const ICONS: Record<PaletteKind, IconName> = {
  tab: "terminal",
  chat: "chat",
  task: "check-circle",
  file: "file",
  worktree: "branch",
  setting: "sliders",
  action: "zap",
};

function KindIcon(props: { kind: PaletteKind }): JSX.Element {
  return <Icon name={ICONS[props.kind]} size={14} className="pal-icon" />;
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
  const [scope, setScope] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ at: number } | null>(null);

  // Every opening starts clean.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setFilter("all");
    setSelected(0);
    setExtra({});
    setScope(null);
    setMenu(null);
  }, [open]);

  const { queryItems } = props;
  const found = queryItems?.(query) ?? [];
  const all = found.length ? [...items, ...found] : items;
  const rows = rank({ items: all, query, filter, current, recent: (id) => recent.at(id), extra, canCreate, now: props.now ?? Date.now(), scope });
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

  const scopes = props.scopes ?? [];
  // Menu entries: "All projects" (null) then one per project.
  const menuEntries: (string | null)[] = [null, ...scopes.map((s) => s.path)];
  const scopeName = scope === null ? null : (scopes.find((s) => s.path === scope)?.name ?? scope);

  function pickScope(next: string | null) {
    setScope(next);
    setMenu(null);
    setSelected(0);
    setExtra({});
  }

  // The menu keeps the keys it uses: Up / Down move, Enter picks, Escape closes only the menu.
  function onMenuKey(e: KeyboardEvent, at: number): void {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setMenu({ at: (at + 1) % menuEntries.length });
        break;
      case "ArrowUp":
        e.preventDefault();
        setMenu({ at: (at - 1 + menuEntries.length) % menuEntries.length });
        break;
      case "Enter":
        e.preventDefault();
        pickScope(menuEntries[at] ?? null);
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        setMenu(null);
        break;
    }
  }

  // A press on a chip or the menu leaves the focus in the search box, so typing and keys still work.
  const keepFocus = (e: { preventDefault(): void }) => e.preventDefault();

  function toggleMenu() {
    setMenu(menu ? null : { at: Math.max(0, menuEntries.indexOf(scope)) });
  }

  function onKeyDown(e: KeyboardEvent) {
    // An Enter that confirms an IME candidate (Telex, CJK) is not a command.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (menu && ["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(e.key)) {
      onMenuKey(e, menu.at);
      return;
    }
    // While the menu is open, Tab and the digit shortcuts would act on rows behind it: they close it instead.
    if (menu && (e.key === "Tab" || /^[1-9]$/.test(e.key))) {
      e.preventDefault();
      setMenu(null);
      return;
    }
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
      onMouseDown={(e) => {
        // A press outside the menu and its button closes the menu.
        const target = e.target as Element | null;
        if (menu && !target?.closest?.(".pal-scope-menu, .pal-filter-btn")) setMenu(null);
      }}
      onCancel={(e) => {
        // Escape: close through state, so `open` stays the single source of truth. An open menu takes it first.
        e.preventDefault();
        if (menu) setMenu(null);
        else onClose();
      }}
    >
      <h2 id="palette-title" className="pal-title">
        {t("palette.title")}
      </h2>
      <div className="pal-input-row">
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
        {scopes.length > 0 && (
          <button
            type="button"
            className="pal-filter-btn"
            aria-label={t("palette.scope.button")}
            title={t("palette.scope.button")}
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            data-active={scope !== null}
            tabIndex={-1}
            onMouseDown={keepFocus}
            onClick={toggleMenu}
          >
            <Icon name="filter" size={14} />
          </button>
        )}
        {menu && (
          <div className="pal-scope-menu" role="menu" aria-label={t("palette.scope.button")}>
            {menuEntries.map((path, i) => (
              <div
                key={path ?? "all"}
                role="menuitemradio"
                aria-checked={path === scope}
                className="pal-scope-item"
                data-selected={i === menu.at}
                onMouseDown={keepFocus}
                onClick={() => pickScope(path)}
              >
                {path === null ? t("palette.scope.all") : scopes[i - 1].name}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="pal-filters">
        <div className="pal-kinds" role="tablist">
          {FILTERS.map((f) => (
            <button key={f} type="button" role="tab" aria-selected={f === filter} className="pal-chip" data-active={f === filter} tabIndex={-1} onMouseDown={keepFocus} onClick={() => pickFilter(f)}>
              {t(`palette.filter.${f}`)}
            </button>
          ))}
        </div>
        {scopeName !== null && (
          <span className="pal-chip pal-scope-chip" data-active="true">
            {scopeName}
            <button type="button" className="pal-scope-clear" aria-label={t("palette.scope.clear")} title={t("palette.scope.clear")} tabIndex={-1} onMouseDown={keepFocus} onClick={() => pickScope(null)}>
              <Icon name="close" size={12} />
            </button>
          </span>
        )}
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
