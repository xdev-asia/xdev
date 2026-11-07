import type { JSX, KeyboardEvent } from "react";
import { Button } from "@xdev-asia/ui";
import { useI18n } from "@/i18n";
import { ago } from "./ago";
import { reasonKey } from "./attention";
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
export function BellMenu(props: { rows: BellRow[]; now: number; onJump(tab: Tab): void; onToggleRead?(tab: Tab): void; onViewActivity?(): void; onClose(): void }): JSX.Element {
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
              const reason = row.tab.unreadReason ? t(reasonKey(row.tab.unreadReason)) : null;
              const toggle = t(row.tab.unread ? "attention.markRead" : "attention.markUnread");
              return (
                <div key={row.tab.id} className="ws-bell-item">
                  <button
                    type="button"
                    role="menuitem"
                    className="ws-bell-row"
                    aria-label={reason ? t("status.bell.rowReason", { worktree: row.worktree, name: row.name, state, reason, age }) : t("status.bell.row", { worktree: row.worktree, name: row.name, state, age })}
                    onClick={() => props.onJump(row.tab)}
                  >
                    {StatusGlyph({ status: row.tab.status, label: state })}
                    <span className="ws-bell-wt">{row.worktree}</span>
                    <span className="ws-bell-name">{row.name}</span>
                    <span className="ws-bell-state">{state}</span>
                    {reason && <span className="ws-bell-reason">{reason}</span>}
                    <span className="ws-bell-age">{age}</span>
                  </button>
                  {props.onToggleRead && (
                    <button type="button" className="ws-bell-toggle" onClick={() => props.onToggleRead?.(row.tab)}>
                      {toggle}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {props.onViewActivity && (
          <Button variant="secondary" type="button" className="ws-bell-activity" onClick={props.onViewActivity}>
            {t("status.bell.viewActivity")}
          </Button>
        )}
      </div>
    </>
  );
}
