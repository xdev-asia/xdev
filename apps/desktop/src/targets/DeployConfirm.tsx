import { Dialog } from "@xdev-asia/ui";
import type { JSX } from "react";
import type { DeployPreset } from "@/api";
import { useI18n } from "@/i18n";

/** The one question before a deploy: shows the exact command that will be typed. */
export function DeployConfirm(props: { preset: DeployPreset; onConfirm(): void; onCancel(): void }): JSX.Element {
  const { t } = useI18n();
  const { preset } = props;
  return (
    <Dialog
      modal
      body="plain"
      title={t("targets.deploy.confirm.title", { name: preset.name })}
      confirmLabel={t("targets.deploy.confirm.run")}
      cancelLabel={t("dialog.cancel")}
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
    >
      <p>{t("targets.deploy.confirm.body")}</p>
      <pre className="targets-command" tabIndex={0} aria-label={t("targets.deploy.confirm.command")}>
        {preset.run}
      </pre>
    </Dialog>
  );
}
