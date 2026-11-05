import type { JSX } from "react";
import type { WorkStatus } from "@/api";
import { useI18n } from "@/i18n";

const STATUSES: WorkStatus[] = ["todo", "in-progress", "in-review", "completed"];

/** Shown above the list while two or more worktrees are selected. */
export function BulkBar(props: { count: number; allPinned: boolean; canSleep: boolean; onArchive(): void; onDelete(): void; onPin(): void; onSleep(): void; onStatus(status: WorkStatus): void; onClear(): void; onSendPrompt?(): void }): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="ws-bulk-bar" role="toolbar" aria-label={t("bulk.bar.label")}>
      <span className="ws-bulk-count">{t("bulk.bar.count", { count: props.count })}</span>
      <button type="button" className="btn-secondary" onClick={props.onArchive}>
        {t("workspace.archive.menu")}
      </button>
      <button type="button" className="btn-secondary" onClick={props.onDelete}>
        {t("bulk.bar.delete")}
      </button>
      <button type="button" className="btn-secondary" onClick={props.onPin}>
        {t(props.allPinned ? "bulk.bar.unpin" : "bulk.bar.pin")}
      </button>
      <button type="button" className="btn-secondary" disabled={!props.canSleep} title={t("bulk.bar.sleep.hint")} onClick={props.onSleep}>
        {t("sleep.menu")}
      </button>
      {props.onSendPrompt && (
        <button type="button" className="btn-secondary" onClick={props.onSendPrompt}>
          {t("bulk.bar.sendPrompt")}
        </button>
      )}
      <select
        className="ws-bulk-status"
        aria-label={t("bulk.bar.status")}
        value=""
        onChange={(e) => {
          if (e.target.value) props.onStatus(e.target.value as WorkStatus);
        }}
      >
        <option value="">{t("bulk.bar.status")}</option>
        {STATUSES.map((s) => (
          <option key={s} value={s}>
            {t(`workspace.work.${s}`)}
          </option>
        ))}
      </select>
      <button type="button" className="btn-secondary" onClick={props.onClear}>
        {t("bulk.bar.clear")}
      </button>
    </div>
  );
}
