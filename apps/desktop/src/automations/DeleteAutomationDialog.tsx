import { useState } from "react";
import type { JSX } from "react";
import { Checkbox } from "@xdev-asia/ui";
import type { Api, Automation } from "@/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useI18n } from "@/i18n";
import { setAutomationsSettings } from "@/settings/automationsSettings";
import { pushToast } from "@/workspace/toastStore";

type T = (key: string, vars?: Record<string, string | number>) => string;

/** Deletes an automation. With "Don't ask again" ticked the setting is stored and a toast says how to undo it. */
export async function deleteAutomation(
  api: Api,
  a: Automation,
  opts: { dontAsk: boolean; openSettings(section: string): void; t: T },
): Promise<void> {
  await api.automationDelete(a.id);
  pushToast({ text: opts.t("automations.toast.deleted") });
  if (!opts.dontAsk) return;
  try {
    const stored = await api.automationsSettingsPut({ ...(await api.automationsSettings()), skipDeleteConfirm: true });
    setAutomationsSettings(stored);
    pushToast({
      text: `${opts.t("automations.delete.toast.skip")} ${opts.t("automations.delete.toast.hint")}`,
      actions: [{ label: opts.t("automations.delete.toast.action"), run: () => opts.openSettings("automations") }],
    });
  } catch {
    // The automation is gone; only the preference was not kept.
  }
}

/** The confirmation before a delete: what goes, what stays, where the runs happened. */
export function DeleteAutomationDialog(props: {
  automation: Automation | null;
  onConfirm(dontAsk: boolean): void;
  onCancel(): void;
}): JSX.Element {
  const { t } = useI18n();
  const [dontAsk, setDontAsk] = useState(false);
  const a = props.automation;
  return (
    <ConfirmDialog
      open={a !== null}
      title={t("automations.delete.title")}
      body={a ? t("automations.delete.body", { name: a.name }) : ""}
      confirmLabel={t("automations.delete.confirm")}
      onConfirm={() => props.onConfirm(dontAsk)}
      onCancel={props.onCancel}
    >
      {a && <p className="dialog-body">{t(a.workspaceMode === "existing" ? "automations.delete.location.existing" : "automations.delete.location.new")}</p>}
      <Checkbox label={t("automations.delete.dontAsk")} checked={dontAsk} data-act="dont-ask" onChange={(e) => setDontAsk(e.target.checked)} />
    </ConfirmDialog>
  );
}
