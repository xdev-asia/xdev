import { Icon } from "@xdev-asia/ui";
import type { JSX } from "react";
import { countLabel } from "@/changes/changes";
import { useI18n } from "@/i18n";
import { visibleApps, type AppId } from "@/shell/apps";

export function ActivityBar(props: { active: AppId; changeCount: number | null; onSelect(app: AppId): void; /** App ids Settings > Appearance hides. */ hidden?: readonly string[] }): JSX.Element {
  const { t } = useI18n();
  const pending = props.changeCount !== null && props.changeCount > 0 ? props.changeCount : null;
  return (
    <nav className="activitybar" aria-label={t("apps.label")}>
      {visibleApps(props.hidden ?? []).map((id) => {
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
            <Icon name={id} size={22} />
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
