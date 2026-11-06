import { Dialog, Field } from "@xdev-asia/ui";
import { useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api } from "@/api";
import { useI18n } from "@/i18n";

/**
 * Asks for the OpenAI key and hands it to the keychain through `aiKeySet`. The key lives only in
 * this field until the save answers; it is never shown again, logged or kept in settings.
 */
export function OpenAiKeyDialog(props: { api: Pick<Api, "aiKeySet">; onSaved(): void; onCancel(): void }): JSX.Element {
  const { api } = props;
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const empty = draft.trim() === "";

  async function save(): Promise<void> {
    if (busy || empty) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.aiKeySet("openai", draft.trim());
      setDraft("");
      props.onSaved();
    } catch (e) {
      const code = toApiError(e).code;
      setError(code === "too_large" ? t("settings.usage.apiKeys.tooLong") : t(`error.${code}`));
    } finally {
      setBusy(false);
    }
  }

  const cancel = () => {
    setDraft("");
    props.onCancel();
  };

  return (
    <Dialog
      modal
      title={t("settings.voice.keyDialogTitle")}
      description={t("settings.voice.keyHint")}
      confirmLabel={t("settings.voice.keySave")}
      labels={{ cancel: t("dialog.cancel") }}
      confirmDisabled={empty}
      busy={busy}
      onConfirm={() => void save()}
      onCancel={cancel}
    >
      <Field
        label={t("settings.voice.key")}
        type="password"
        data-field="openai-key"
        value={draft}
        error={error}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void save();
          }
        }}
      />
    </Dialog>
  );
}
