import { CommandPalette, Icon, Kbd, type IconName, type PaletteRow } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import type { JSX, KeyboardEvent, MouseEvent, ReactNode } from "react";
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

const selectable = (r: Row) => r.type !== "header";
const MORE_ID = "more:";
const CREATE_ID = "create:";

/** The id a ranked row has in the palette; items keep their own id. */
function idOf(row: Row): string {
  switch (row.type) {
    case "item":
      return row.item.id;
    case "more":
      return `${MORE_ID}${row.section}`;
    case "create":
      return CREATE_ID;
    default:
      return "";
  }
}

/** The "Jump to…" dialog: a query, a kind filter and the ranked rows, drawn by the design system palette. */
export function JumpPalette(props: JumpPaletteProps): JSX.Element {
  const { open, items, current, recent, canCreate, onCreate, onClose } = props;
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [active, setActive] = useState<string | null>(null);
  const [extra, setExtra] = useState<Partial<Record<Filter, number>>>({});
  const [scope, setScope] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ at: number } | null>(null);

  // Every opening starts clean; the search box takes the focus and gives it back on close.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setFilter("all");
    setActive(null);
    setExtra({});
    setScope(null);
    setMenu(null);
    if (typeof document === "undefined") return;
    const before = document.activeElement as HTMLElement | null;
    document.querySelector<HTMLInputElement>(".pal-host .pal-input")?.focus();
    return () => before?.focus?.();
  }, [open]);

  const { queryItems } = props;
  const found = queryItems?.(query) ?? [];
  const all = found.length ? [...items, ...found] : items;
  const rows = rank({ items: all, query, filter, current, recent: (id) => recent.at(id), extra, canCreate, now: props.now ?? Date.now(), scope });
  const picks = rows.filter(selectable);
  const byId = new Map(picks.map((r) => [idOf(r), r]));
  const activeId = byId.has(active ?? "") ? (active as string) : picks[0] ? idOf(picks[0]) : "";

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

  function pickFilter(next: Filter) {
    setFilter(next);
    setActive(null);
    setExtra({});
  }

  function cycle(by: number) {
    pickFilter(FILTERS[(FILTERS.indexOf(filter) + by + FILTERS.length) % FILTERS.length]);
  }

  const scopes = props.scopes ?? [];
  // Menu entries: "All projects" (null) then one per project.
  const menuEntries: (string | null)[] = [null, ...scopes.map((s) => s.path)];
  const scopeName = scope === null ? null : (scopes.find((s) => s.path === scope)?.name ?? scope);

  function pickScope(next: string | null) {
    setScope(next);
    setMenu(null);
    setActive(null);
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

  function toggleMenu() {
    setMenu(menu ? null : { at: Math.max(0, menuEntries.indexOf(scope)) });
  }

  // Runs before the palette's own keys (arrows, Home, End, Enter, Escape); a prevented key is not handled twice.
  function onInputKeyDown(e: KeyboardEvent<HTMLInputElement>) {
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
    if (e.key === "Tab") {
      e.preventDefault();
      cycle(e.shiftKey ? -1 : 1);
    }
  }

  // A press anywhere in the palette but the search box leaves the focus there, so typing and keys still work.
  // A press outside the menu and its button closes the menu.
  function onMouseDown(e: MouseEvent) {
    const target = e.target as Element | null;
    if (target?.tagName !== "INPUT") e.preventDefault();
    if (menu && !target?.closest?.(".pal-scope-menu, .pal-filter-btn")) setMenu(null);
  }

  const addon: ReactNode =
    scopes.length > 0 ? (
      <div className="pal-scope-host">
        {scopeName !== null && (
          <span className="pal-scope-chip">
            <span className="pal-scope-name">{scopeName}</span>
            <button type="button" className="pal-scope-clear" aria-label={t("palette.scope.clear")} title={t("palette.scope.clear")} tabIndex={-1} onClick={() => pickScope(null)}>
              <Icon name="close" size={12} />
            </button>
          </span>
        )}
        <button
          type="button"
          className="pal-filter-btn"
          aria-label={t("palette.scope.button")}
          title={t("palette.scope.button")}
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          data-active={scope !== null}
          tabIndex={-1}
          onClick={toggleMenu}
        >
          <Icon name="filter" size={14} />
        </button>
        {menu && (
          <div className="pal-scope-menu" role="menu" aria-label={t("palette.scope.button")}>
            {menuEntries.map((path, i) => (
              <div key={path ?? "all"} role="menuitemradio" aria-checked={path === scope} className="pal-scope-item" data-selected={i === menu.at} onClick={() => pickScope(path)}>
                {path === null ? t("palette.scope.all") : scopes[i - 1].name}
              </div>
            ))}
          </div>
        )}
      </div>
    ) : undefined;

  // The ranked rows become sections; a row without a header (Create) joins the last one.
  const sections: { title: string; rows: PaletteRow[] }[] = [];
  const lookup = new Map<string, Row>();
  for (const row of rows) {
    if (row.type === "header") {
      sections.push({ title: t(`palette.section.${row.label}`), rows: [] });
      continue;
    }
    if (!sections.length) sections.push({ title: t("palette.section.worktrees"), rows: [] });
    const id = idOf(row);
    lookup.set(id, row);
    sections[sections.length - 1].rows.push(toRow(row, id));
  }

  function toRow(row: Row, id: string): PaletteRow {
    if (row.type === "more") {
      const title = t("palette.more", { count: row.count });
      return { id, title, icon: "more", label: <span className="pal-more">{title}</span> };
    }
    if (row.type === "create") {
      const title = t("palette.create", { name: row.name });
      return { id, title, icon: ICONS.worktree, label: title };
    }
    if (row.type !== "item") return { id, title: "" };
    const { item } = row;
    const meta =
      item.detail || item.status || item.hint || row.digit !== null ? (
        <>
          {item.detail && (
            <span className="pal-meta-detail">
              <Highlight text={item.detail} hits={row.hits.detail} />
            </span>
          )}
          {item.status && <span className="pal-dot" data-status={item.status} title={t(`palette.status.${item.status}`)} />}
          {item.hint && <Kbd>{item.hint}</Kbd>}
          {row.digit !== null && <Kbd>{String(row.digit)}</Kbd>}
        </>
      ) : undefined;
    return { id, title: item.title, icon: ICONS[item.kind], label: <Highlight text={item.title} hits={row.hits.title} />, meta };
  }

  return (
    <div className="pal-host" onMouseDown={onMouseDown}>
      <CommandPalette
        open={open}
        title={t("palette.title")}
        placeholder={t("palette.placeholder")}
        labels={{ noMatches: t("palette.empty"), move: t("palette.hint.move"), open: t("palette.hint.open"), close: t("palette.hint.close"), scopes: t("palette.kinds") }}
        filter={false}
        sections={sections}
        query={query}
        onQueryChange={(q) => {
          setQuery(q);
          setActive(null);
          setExtra({});
        }}
        scopes={FILTERS.map((f) => ({ value: f, label: t(`palette.filter.${f}`) }))}
        scope={filter}
        onScopeChange={(f) => pickFilter(f as Filter)}
        inputAddon={addon}
        activeId={activeId}
        onActiveChange={setActive}
        onInputKeyDown={onInputKeyDown}
        onSelect={(row) => run(lookup.get(row.id ?? ""))}
        onClose={onClose}
        footer={
          <>
            <span>
              <Kbd>Tab</Kbd> {t("palette.hint.filter")}
            </span>
            <span>
              <Kbd>1–9</Kbd> {t("palette.hint.pick")}
            </span>
          </>
        }
      />
    </div>
  );
}
