import type { JSX } from "react";
import { useI18n } from "@/i18n";
import { Button } from "@xdev-asia/ui";

/** A file that failed to load: why, a Retry, and Reveal when the caller has one. */
export function LoadError(props: { code: string; onRetry: () => void; onReveal?: () => void }): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="file-note" role="alert">
      <p className="ws-empty">{t("files.loadError.title")}</p>
      <p className="file-note-body">{t(`error.${props.code}`)}</p>
      <Button variant="primary" type="button" onClick={props.onRetry}>{t("files.retry")}</Button>
      {props.onReveal && (
        <button type="button" className="btn-secondary" onClick={props.onReveal}>
          {t("files.menu.reveal")}
        </button>
      )}
    </div>
  );
}
