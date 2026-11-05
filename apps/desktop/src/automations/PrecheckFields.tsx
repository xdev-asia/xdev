import type { JSX } from "react";
import { Field, Select } from "@xdev-asia/ui";
import { useI18n } from "@/i18n";
import { TIMEOUT_OPTIONS } from "./schedule";

const label = (seconds: number, t: (k: string) => string) => (TIMEOUT_OPTIONS.includes(seconds) ? t(`automations.precheck.timeout.${seconds}`) : `${seconds} s`);

/** The optional precheck: a command that must exit 0 in the run's folder, and how long it may take. */
export function PrecheckFields(props: { command: string; timeout: number; onChange(next: { command: string; timeout: number }): void }): JSX.Element {
  const { t } = useI18n();
  const values = TIMEOUT_OPTIONS.includes(props.timeout) ? TIMEOUT_OPTIONS : [...TIMEOUT_OPTIONS, props.timeout].sort((a, b) => a - b);
  return (
    <div className="au-precheck">
      <Field
        label={t("automations.precheck.label")}
        hint={t("automations.precheck.help")}
        value={props.command}
        placeholder={t("automations.precheck.placeholder")}
        spellCheck={false}
        className="ws-mono"
        data-act="precheck"
        onChange={(e) => props.onChange({ command: e.target.value, timeout: props.timeout })}
      />
      <label className="ws-field">
        <span>{t("automations.precheck.timeout")}</span>
        <Select
          value={String(props.timeout)}
          data-act="precheck-timeout"
          options={values.map((v) => ({ value: String(v), label: label(v, t) }))}
          onChange={(e) => props.onChange({ command: props.command, timeout: Number(e.target.value) })}
        />
      </label>
    </div>
  );
}
