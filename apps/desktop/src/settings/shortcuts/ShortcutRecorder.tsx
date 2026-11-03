import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useI18n } from "@/i18n";
import { suspendKeymap } from "@/keys/keymap";
import { recorderStep } from "./recorder";

export interface RecorderClash {
  chord: string;
  /** Titles of the actions that hold it now. */
  titles: string[];
}

/**
 * Listens for the next chord while open. The keymap is suspended meanwhile, so the keys pressed are
 * recorded, not run. Escape cancels; Backspace clears the action's shortcuts.
 */
export function ShortcutRecorder(props: {
  clash: RecorderClash | null;
  onChord(chord: string): void;
  onClear(): void;
  onReplace(): void;
  onCancel(): void;
}): JSX.Element {
  const { clash, onChord, onClear, onReplace, onCancel } = props;
  const { t } = useI18n();
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    suspendKeymap(true);
    function onKey(e: KeyboardEvent) {
      if (clash) {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
        return;
      }
      const step = recorderStep(e);
      if (step.kind === "ignore") return;
      e.preventDefault();
      e.stopPropagation();
      setInvalid(step.kind === "invalid");
      if (step.kind === "cancel") onCancel();
      else if (step.kind === "clear") onClear();
      else if (step.kind === "chord") onChord(step.chord);
    }
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      suspendKeymap(false);
    };
  }, [clash, onChord, onClear, onCancel]);

  return (
    <div className="keys-recorder" role="group" aria-label={t("keys.rec.prompt")}>
      {clash ? (
        <>
          <span className="keys-rec-text" role="alert">
            {t("keys.rec.conflict", { chord: clash.chord, actions: clash.titles.join(", ") })}
          </span>
          <button type="button" className="btn-secondary" onClick={onReplace}>
            {t("keys.rec.replace")}
          </button>
          <button type="button" className="btn-secondary" onClick={onCancel}>
            {t("keys.rec.cancel")}
          </button>
        </>
      ) : (
        <>
          <span className="keys-rec-text" data-invalid={invalid || undefined} role={invalid ? "alert" : "status"}>
            {invalid ? t("keys.rec.invalid") : t("keys.rec.prompt")}
          </span>
          <small className="settings-hint">{t("keys.rec.hint")}</small>
          <button type="button" className="btn-secondary" onClick={onCancel}>
            {t("keys.rec.cancel")}
          </button>
        </>
      )}
    </div>
  );
}
