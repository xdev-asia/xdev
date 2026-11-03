import type { JSX } from "react";
import type { MenuItem } from "@/ui/ContextMenu";
import { flatRows, type Row, type Section } from "./model";

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The title of a section; the project one names the repo. */
export const sectionTitle = (t: T, s: Section, repoName: string): string =>
  s.id === "project" ? t("qcmd.section.project", { repo: repoName }) : t(`qcmd.section.${s.id}`);

/**
 * The rows of the quick commands, grouped by section: plain markup, no hooks. The popover on the tab
 * strip draws it under its search box. `onChoose` gets whether Shift was held.
 */
export function QuickCommandsMenu(props: {
  sections: Section[];
  /** The `key` of the row the keyboard is on. */
  active?: string | null;
  repoName: string;
  t: T;
  onChoose?(row: Row, shift: boolean): void;
  onHover?(row: Row): void;
  /** Shown under "From xdev.toml" while its commands are not trusted. */
  onTrust?(): void;
}): JSX.Element {
  const { t } = props;
  return (
    <div className="qc-list" role="menu">
      {props.sections.map((s) => (
        <div key={s.id} className="qc-section" role="group" aria-label={sectionTitle(t, s, props.repoName)}>
          <div className="qc-section-title" aria-hidden="true">
            {sectionTitle(t, s, props.repoName)}
          </div>
          {s.untrusted && (
            <div className="qc-untrusted">
              <span>{t("qcmd.notTrusted")}</span>
              {props.onTrust && (
                <button type="button" className="btn-secondary" onClick={props.onTrust}>
                  {t("qcmd.reviewTrust")}
                </button>
              )}
            </div>
          )}
          {s.rows.map((r) => (
            <button
              key={r.key}
              type="button"
              role="menuitem"
              className="qc-row"
              data-key={r.key}
              data-active={props.active === r.key || undefined}
              aria-disabled={r.reason !== null || undefined}
              title={r.reason ? t(`qcmd.reason.${r.reason}`) : undefined}
              onMouseEnter={() => r.reason === null && props.onHover?.(r)}
              onClick={(e) => r.reason === null && props.onChoose?.(r, e.shiftKey)}
            >
              <span className="qc-row-label">{r.label}</span>
              <span className="qc-badge" data-badge={r.badge}>
                {t(`qcmd.badge.${r.badge}`)}
              </span>
              <span className="qc-row-text ws-mono">{r.detail}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * The same rows as items of a context menu, for the terminal right-click menu: each row runs with
 * `onChoose`; one that cannot run is disabled. A label is the text of the command itself, not an
 * i18n key (a key that is not in the dictionary shows as it is).
 */
export function quickCommandMenuItems(sections: Section[], onChoose: (row: Row) => void): MenuItem[] {
  return flatRows(sections.filter((s) => s.id !== "recent")).map((r) => ({
    id: r.key,
    labelKey: r.label,
    disabled: r.reason !== null,
    run: () => onChoose(r),
  }));
}
