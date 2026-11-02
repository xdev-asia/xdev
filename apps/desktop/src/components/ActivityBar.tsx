import type { JSX } from "react";
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
                {pending}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
