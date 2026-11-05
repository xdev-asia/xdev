import { useState } from "react";
import type { JSX } from "react";
import { Button, Textarea } from "@xdev-asia/ui";
import { useI18n } from "@/i18n";
import { isSendKey } from "./prComments";

const isMac = (): boolean => typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

/**
 * A box for a comment or a reply. Ctrl+Enter (Cmd+Enter on macOS) sends; Enter that ends an IME
 * composition never does. `onSubmit` says whether the post worked; the box clears only then.
 */
export function PrComposer(props: {
  label: string;
  submitLabel: string;
  onSubmit: (body: string) => Promise<boolean>;
  onCancel?: () => void;
  /** Shown under the box when the last post failed. */
  error?: string | null;
}): JSX.Element {
  const { label, submitLabel, onSubmit, onCancel, error } = props;
  const { t } = useI18n();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(): Promise<void> {
    if (busy || body.trim() === "") return;
    setBusy(true);
    try {
      if (await onSubmit(body)) setBody("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="ws-prc-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <Textarea
        label={label}
        rows={3}
        value={body}
        error={error ?? undefined}
        hint={t(isMac() ? "prc.compose.hint.mac" : "prc.compose.hint")}
        disabled={busy}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (isSendKey({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, isComposing: e.nativeEvent.isComposing })) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="ws-prc-composer-actions">
        {onCancel && (
          <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
            {t("prc.cancel")}
          </Button>
        )}
        <Button type="submit" variant="secondary" disabled={busy || body.trim() === ""}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
