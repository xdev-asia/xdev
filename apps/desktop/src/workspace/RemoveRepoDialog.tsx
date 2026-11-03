import type { JSX } from "react";
import type { ApiError } from "@/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useI18n } from "@/i18n";

/** Mounted only while open: asks before a repo leaves xDev. Nothing is deleted from disk. */
export function RemoveRepoDialog(props: {
  name: string;
  /** How many worktrees leave the sidebar. */
  worktrees: number;
  /** Titles of the open tabs in those worktrees; they close after the confirm. */
  tabs: string[];
  error?: ApiError["code"];
  onConfirm(): void;
  onCancel(): void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <ConfirmDialog
      open
      title={t("project.remove.title", { name: props.name })}
      body={t("project.remove.body", { count: props.worktrees })}
      confirmLabel={t("project.remove.confirm")}
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
    >
      {props.tabs.length > 0 && (
        <div className="dialog-body">
          <p>{t("project.remove.tabs", { count: props.tabs.length })}</p>
          <ul className="ws-remove-tabs">
            {props.tabs.map((title, i) => (
              <li key={i} className="ws-mono">
                {title}
              </li>
            ))}
          </ul>
        </div>
      )}
      {props.error && (
        <p className="error-text" role="alert">
          {t(`error.${props.error}`)}
        </p>
      )}
    </ConfirmDialog>
  );
}
