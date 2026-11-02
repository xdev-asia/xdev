import type { JSX } from "react";
import { countLabel } from "../changes/changes";
import { useI18n } from "../i18n";
import { APPS, type AppId } from "../shell/apps";

const ICONS: Record<AppId, JSX.Element> = {
  docs: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h6" />
    </>
  ),
  changes: (
    <>
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="8" r="2" />
      <path d="M6 8v8M18 10c0 4-4 4-10 6.5" />
    </>
  ),
  tasks: (
    <>
      <path d="M10 6h10M10 12h10M10 18h10" />
      <path d="m4 6 1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17" />
    </>
  ),
  squads: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" />
      <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.3c2.1.7 3.5 2.8 3.5 5.7" />
    </>
  ),
  agents: (
    <>
      <rect x="5" y="8" width="14" height="11" rx="2" />
      <path d="M12 8V4M10 4h4M3 12v3M21 12v3" />
      <circle cx="9.5" cy="13" r="1" />
      <circle cx="14.5" cy="13" r="1" />
    </>
  ),
  accounts: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" />
    </>
  ),
};

export function ActivityBar(props: { active: AppId; changeCount: number | null; onSelect(app: AppId): void }): JSX.Element {
  const { t } = useI18n();
  const pending = props.changeCount !== null && props.changeCount > 0 ? props.changeCount : null;
  return (
    <nav className="activitybar" aria-label={t("apps.label")}>
      {APPS.map((id) => {
        const label = id === "changes" && pending !== null ? t("apps.changesCount", { count: pending }) : t(`apps.${id}`);
        return (
          <button
            key={id}
            type="button"
            className="activity"
            data-app={id}
            aria-label={label}
            title={label}
            aria-current={id === props.active ? "page" : undefined}
            onClick={() => props.onSelect(id)}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {ICONS[id]}
            </svg>
            {id === "changes" && pending !== null && (
              <span className="activity-badge" aria-hidden="true">
                {countLabel(pending)}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
