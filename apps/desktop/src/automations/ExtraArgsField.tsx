import type { JSX } from "react";
import { Button, Field, FieldMessage } from "@xdev-asia/ui";
import type { ExtraArgsError } from "@/api";
import { useI18n } from "@/i18n";
import { extraArgsMessage } from "./editorModel";

/** Extra agent arguments. Arguments with a reused session are refused with a way out: use fresh sessions. */
export function ExtraArgsField(props: {
  value: string;
  /** Extra arguments need a fresh session: the session is set to reuse. */
  conflict: boolean;
  error: ExtraArgsError | null;
  onChange(value: string): void;
  onUseFresh(): void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="au-extra">
      <Field
        label={t("automations.editor.extraArgs")}
        hint={t("automations.editor.extraArgs.help")}
        value={props.value}
        placeholder={t("automations.editor.extraArgs.placeholder")}
        spellCheck={false}
        className="ws-mono"
        data-act="extra-args"
        onChange={(e) => props.onChange(e.target.value)}
      />
      {props.error && <FieldMessage tone="error">{extraArgsMessage(props.error, t)}</FieldMessage>}
      {props.conflict && (
        <div className="au-conflict" role="alert">
          <FieldMessage tone="warn">{t("automations.editor.needsFreshSession")}</FieldMessage>
          <Button variant="secondary" type="button" data-act="use-fresh" onClick={props.onUseFresh}>
            {t("automations.editor.useFresh")}
          </Button>
        </div>
      )}
    </div>
  );
}
