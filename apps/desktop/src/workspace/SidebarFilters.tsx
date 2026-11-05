import { useState } from "react";
import type { JSX } from "react";
import type { SidebarPrefs } from "@/api";
import { useI18n } from "@/i18n";

const KEYS = ["hideDefault", "hideDetached", "hideAutomation", "hideCli"] as const;

/**
 * The filter button of the sidebar header: four switches saved as preferences and Sleeping only (kept by
 * the list, not saved), and "N hidden" that clears them.
 */
export function SidebarFilters(props: {
  prefs: SidebarPrefs;
  hidden: number;
  onPrefs(prefs: SidebarPrefs): void;
  sleepingOnly?: boolean;
  onSleepingOnly?(on: boolean): void;
}): JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const { prefs } = props;
  const sleepingOnly = props.sleepingOnly === true;
  const on = KEYS.some((k) => prefs[k]) || sleepingOnly;
  return (
    <div className="ws-filters">
      {on && (
        <button
          type="button"
          className="ws-filters-hidden"
          title={t("filters.clear")}
          onClick={() => {
            props.onSleepingOnly?.(false);
            props.onPrefs({ ...props.prefs, hideDefault: false, hideDetached: false, hideAutomation: false, hideCli: false });
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
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 5h18l-7 8v6l-4-2v-4z" />
        </svg>
      </button>
      {open && (
        <div className="ws-filters-pop" role="group" aria-label={t("filters.button")} onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
          {KEYS.map((key) => (
            <label key={key} className="ws-filters-row">
              <input type="checkbox" checked={prefs[key]} onChange={(e) => props.onPrefs({ ...prefs, [key]: e.target.checked })} />
              <span>{t(`filters.${key}`)}</span>
            </label>
          ))}
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
