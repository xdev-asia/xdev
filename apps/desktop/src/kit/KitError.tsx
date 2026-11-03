import type { JSX } from "react";
import { toApiError } from "@/api";
import { useI18n } from "@/i18n";

/** What a kit tab keeps of a failure: the code the text comes from, and the detail that came with it. */
export interface KitErr {
  code: string;
  detail?: string;
}

/** An error as the kit shows it; `changed` is worded for the kit, where it also means a name is taken. */
export function kitErr(e: unknown, changed = false): KitErr {
  const { code, detail } = toApiError(e);
  return { code: changed && code === "changed" ? "kit_changed" : code, ...(detail ? { detail } : {}) };
}

/** The message for a failure, with its detail in a muted line after it when there is one. */
export function KitError(props: { error: KitErr }): JSX.Element {
  const { t } = useI18n();
  const { code, detail } = props.error;
  return (
    <div role="alert">
      <p className="error-text">{code === "kit_changed" ? t("kit.error.changed") : t(`error.${code}`)}</p>
      {detail && detail.trim() !== "" && <p className="kit-detail">{detail}</p>}
    </div>
  );
}
