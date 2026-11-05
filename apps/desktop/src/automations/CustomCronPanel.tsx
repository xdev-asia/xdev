import type { JSX } from "react";
import { Field, FieldMessage } from "@xdev-asia/ui";
import { useI18n } from "@/i18n";
import { cronFields, cronMessage } from "./editorModel";

const CAPTIONS = ["minute", "hour", "day", "month", "weekday"] as const;

/** The custom schedule: one cron input, a caption under each of its five fields, and a live message. */
export function CustomCronPanel(props: {
  cron: string;
  /** The error key `automationValidateSchedule` gave, or null when the cron is valid. */
  error: string | null;
  onChange(cron: string): void;
}): JSX.Element {
  const { t } = useI18n();
  const message = cronMessage(props.cron, props.error, t);
  const fields = cronFields(props.cron);
  return (
    <div className="au-cron">
      <Field
        label={t("automations.cron.label")}
        value={props.cron}
        placeholder={t("automations.cron.placeholder")}
        spellCheck={false}
        className="ws-mono"
        aria-invalid={message.tone === "error"}
        data-act="cron"
        onChange={(e) => props.onChange(e.target.value)}
      />
      <ol className="au-cron-fields" aria-hidden="true">
        {CAPTIONS.map((c, i) => (
          <li key={c}>
            <code>{fields[i] || "·"}</code>
            <span>{t(`automations.cron.${c}`)}</span>
          </li>
        ))}
      </ol>
      <FieldMessage tone={message.tone === "error" ? "error" : "info"}>{message.text}</FieldMessage>
    </div>
  );
}
