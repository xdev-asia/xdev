import type { JSX } from "react";
import { Select } from "@xdev-asia/ui";
import { useI18n } from "@/i18n";
import { GRACE_OPTIONS, graceLabel } from "./schedule";

/** How late a run may start after it was due. A stored value that is not a listed option stays listed. */
export function GraceField(props: { value: number; onChange(minutes: number): void }): JSX.Element {
  const { t } = useI18n();
  const values = GRACE_OPTIONS.includes(props.value) ? GRACE_OPTIONS : [...GRACE_OPTIONS, props.value].sort((a, b) => a - b);
  return (
    <label className="ws-field">
      <span>{t("automations.grace.label")}</span>
      <Select
        value={String(props.value)}
        data-act="grace"
        options={values.map((v) => ({ value: String(v), label: graceLabel(v, t) }))}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
      <small className="settings-hint">{t("automations.grace.help")}</small>
    </label>
  );
}
