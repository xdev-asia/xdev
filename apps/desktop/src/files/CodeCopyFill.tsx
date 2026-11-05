import { useEffect } from "react";
import type { RefObject } from "react";
import { useI18n } from "@/i18n";
import { fillCodeCopy } from "./codeCopy";

/** Puts a copy button on each fenced block of `host` after its HTML (`html`) is set. Renders nothing. */
export function CodeCopyFill(props: { host: RefObject<HTMLElement | null>; html: string }): null {
  const { host, html } = props;
  const { t } = useI18n();
  const copy = t("files.preview.code.copy");
  const copied = t("files.preview.code.copied");
  useEffect(() => {
    if (host.current) fillCodeCopy(host.current, { copy, copied });
  }, [host, html, copy, copied]);
  return null;
}
