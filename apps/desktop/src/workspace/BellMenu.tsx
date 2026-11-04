import type { JSX, KeyboardEvent } from "react";
import { useI18n } from "@/i18n";
import { ago } from "./ago";
import type { Tab } from "./sessions";
import { StatusGlyph } from "./StatusGlyph";

/** One unread tab in the bell's list, with the names to show for it. */
export interface BellRow {
  tab: Tab;
  worktree: string;
  name: string;
}

/** The count on the bell: up to 99, then "99+". */
export function bellCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/**
 * The bell's list: every unread tab, newest first, with its worktree, name, state and age.
 * A row jumps to that pane. "View activity" opens the Activity feed. Escape or a click outside closes it.
 */
export function BellMenu(props: { rows: BellRow[]; now: number; onJump(tab: Tab): void; onViewActivity?(): void; onClose(): void }): JSX.Element {
  const { t } = useI18n();
  const rows = [...props.rows].sort((a, b) => (b.tab.unreadAt ?? 0) - (a.tab.unreadAt ?? 0));

  function key(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    }
  }

  return (
    <>
      <div className="ws-menu-backdrop" onClick={props.onClose} />
      <div className="ws-bell-pop" tabIndex={-1} onKeyDown={key}>
        <p className="ws-bell-title">{t("status.bell.title")}</p>
        {rows.length === 0 ? (
          <p className="ws-bell-empty" role="status">
            {t("status.bell.empty")}
          </p>
        ) : (
          <div className="ws-bell-list" role="menu" aria-label={t("status.bell.title")}>
            {rows.map((row) => {
              const state = t(`workspace.tabs.status.${row.tab.status}`);
              const age = ago(row.tab.unreadAt ?? props.now, props.now, t);
              return (
                <button
                  key={row.tab.id}
                  type="button"
                  role="menuitem"
                  className="ws-bell-row"
                  aria-label={t("status.bell.row", { worktree: row.worktree, name: row.name, state, age })}
                  onClick={() => props.onJump(row.tab)}
                >
                  {StatusGlyph({ status: row.tab.status, label: state })}
                  <span className="ws-bell-wt">{row.worktree}</span>
                  <span className="ws-bell-name">{row.name}</span>
                  <span className="ws-bell-state">{state}</span>
                  <span className="ws-bell-age">{age}</span>
                </button>
              );
            })}
          </div>
        )}
        {props.onViewActivity && (
          <button type="button" className="ws-bell-activity" onClick={props.onViewActivity}>
            {t("status.bell.viewActivity")}
          </button>
        )}
      </div>
    </>
  );
}
