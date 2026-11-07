import { Icon } from "@xdev-asia/ui";
import { useState } from "react";
import type { JSX } from "react";
import type { SidebarPrefs } from "@/api";
import { useI18n } from "@/i18n";

const KEYS = ["hideDefault", "hideDetached", "hideAutomation", "hideCli"] as const;

/** A project the picker offers. */
export interface ProjectChoice {
  id: string;
  name: string;
}

/**
 * The filter button of the sidebar header: four switches saved as preferences, the project picker
 * (saved too), Sleeping only (kept by the list, not saved), and "N hidden" that clears them.
 */
export function SidebarFilters(props: {
  prefs: SidebarPrefs;
  hidden: number;
  /** The repos to pick from; without them the picker is left out. */
  projects?: ProjectChoice[];
  onPrefs(prefs: SidebarPrefs): void;
  sleepingOnly?: boolean;
  onSleepingOnly?(on: boolean): void;
}): JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const { prefs } = props;
  const sleepingOnly = props.sleepingOnly === true;
  const projects = props.projects ?? [];
  // Ids of repos that are gone do not count as a filter.
  const picked = new Set(prefs.projectFilter.filter((id) => projects.some((p) => p.id === id)));
  const on = KEYS.some((k) => prefs[k]) || sleepingOnly || picked.size > 0;
  const pick = (id: string, checked: boolean) =>
    props.onPrefs({ ...prefs, projectFilter: checked ? [...picked, id] : [...picked].filter((p) => p !== id) });
  return (
    <div className="ws-filters">
      {on && (
        <button
          type="button"
          className="ws-filters-hidden"
          title={t("filters.clear")}
          onClick={() => {
            props.onSleepingOnly?.(false);
            props.onPrefs({ ...props.prefs, hideDefault: false, hideDetached: false, hideAutomation: false, hideCli: false, projectFilter: [] });
          }}
        >
          {t("filters.hidden", { count: props.hidden })}
        </button>
      )}
      <button
        type="button"
        className="ws-icon-btn"
        aria-label={t("filters.button")}
        title={t("filters.button")}
        aria-haspopup="true"
        aria-expanded={open}
        data-on={on ? "true" : undefined}
        onClick={() => setOpen(!open)}
      >
        <Icon name="filter" size={14} />
      </button>
      {open && (
        <div className="ws-filters-pop" role="group" aria-label={t("filters.button")} onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
          {KEYS.map((key) => (
            <label key={key} className="ws-filters-row">
              <input type="checkbox" checked={prefs[key]} onChange={(e) => props.onPrefs({ ...prefs, [key]: e.target.checked })} />
              <span>{t(`filters.${key}`)}</span>
            </label>
          ))}
          {projects.length > 1 && (
            <div className="ws-filters-projects" role="group" aria-label={t("filters.projects")}>
              <span className="ws-options-label">{t("filters.projects")}</span>
              <label className="ws-filters-row">
                <input type="checkbox" checked={picked.size === 0} onChange={() => props.onPrefs({ ...prefs, projectFilter: [] })} />
                <span>{t("filters.projects.all")}</span>
              </label>
              {projects.map((p) => (
                <label key={p.id} className="ws-filters-row">
                  <input type="checkbox" checked={picked.has(p.id)} onChange={(e) => pick(p.id, e.target.checked)} />
                  <span>{p.name}</span>
                </label>
              ))}
            </div>
          )}
          {props.onSleepingOnly && (
            <label className="ws-filters-row">
              <input type="checkbox" checked={sleepingOnly} onChange={(e) => props.onSleepingOnly?.(e.target.checked)} />
              <span>{t("filters.sleepingOnly")}</span>
            </label>
          )}
        </div>
      )}
    </div>
  );
}
