import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Button, IconButton, readThemeColors } from "@xdev-asia/ui";
import { toApiError, type ApiError } from "@/api";
import { useI18n } from "@/i18n";
import { pngFromSvg } from "@/kit/pngFromSvg";
import { CARD_HEIGHT, CARD_WIDTH, SHARE_COLORS, shareCardSvg, shareText, type ShareCardData, type ShareColor } from "@/kit/shareCard";

/** How long "Copied" stays on the button. */
const COPIED_MS = 2000;

type ShareApi = {
  usageShareCopyImage(png: Uint8Array): Promise<void>;
  usageSharePost(text: string): Promise<void>;
};

/** A button that opens a dialog with a usage card to copy as an image, or a post to open in the browser. */
export function UsageShare(props: {
  api: ShareApi;
  data: ShareCardData;
  /** Draws the card as PNG; replaced in tests, which have no canvas. */
  toPng?: (svg: string, width: number, height: number) => Promise<Uint8Array>;
  /** The theme colours of the card; replaced in tests, which have no document. */
  colors?: (el: Element | null) => Record<ShareColor, string>;
}): JSX.Element {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [svg, setSvg] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError["code"]>();
  const dialog = useRef<HTMLDialogElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const translate = (key: string, vars?: Record<string, string | number>) => t(key, vars);

  const close = () => {
    setOpen(false);
    setCopied(false);
    setError(undefined);
  };

  useEffect(() => {
    if (!open) return;
    const d = dialog.current;
    if (d && !d.open) d.showModal();
    const read = props.colors ?? ((el: Element | null) => readThemeColors(el ?? document.documentElement, SHARE_COLORS) as Record<ShareColor, string>);
    setSvg(shareCardSvg(props.data, read(d), translate, locale));
    // The card is drawn again when the figures or the language change while it is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, props.data, locale]);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const toPng = props.toPng ?? pngFromSvg;
      await props.api.usageShareCopyImage(await toPng(svg, CARD_WIDTH, CARD_HEIGHT));
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    } catch (e) {
      // Drawing the card can fail too; the user sees the clipboard message either way.
      const code = toApiError(e).code;
      setError(code.startsWith("share_") ? code : "share_clipboard");
    } finally {
      setBusy(false);
    }
  }

  async function post(): Promise<void> {
    setError(undefined);
    try {
      await props.api.usageSharePost(shareText(props.data, translate, locale));
    } catch (e) {
      setError(toApiError(e).code);
    }
  }

  return (
    <>
      <IconButton icon="download" label={t("usage.share.tooltip")} data-act="share" onClick={() => setOpen(true)} />
      {open && (
        <dialog
          ref={dialog}
          role="dialog"
          aria-modal="true"
          className="dialog ws-dialog usage-share"
          aria-labelledby="usage-share-title"
          onCancel={(e) => {
            e.preventDefault();
            close();
          }}
        >
          <h2 id="usage-share-title" className="dialog-title">
            {t("usage.share.title")}
          </h2>
          <div className="usage-share-card" data-share-card dangerouslySetInnerHTML={{ __html: svg }} />
          {error && (
            <p className="error-text" role="alert" data-share-error>
              {t(`error.${error}`)}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" className="btn-secondary" data-act="share-close" onClick={close}>
              {t("usage.share.close")}
            </button>
            <button type="button" className="btn-secondary" data-act="share-post" onClick={() => void post()}>
              {t("usage.share.post")}
            </button>
            <Button type="button" autoFocus data-act="share-copy" aria-busy={busy} disabled={busy || svg === ""} onClick={() => void copy()}>
              {copied ? t("usage.share.copied") : t("usage.share.copy")}
            </Button>
          </div>
        </dialog>
      )}
    </>
  );
}
