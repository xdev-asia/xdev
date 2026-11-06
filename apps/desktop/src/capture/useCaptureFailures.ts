import { useEffect, useRef } from "react";
import { toApiError, type Api } from "@/api";
import { useI18n, type I18n } from "@/i18n";
import { pushToast } from "@/workspace/toastStore";

/** One toast at a time: a new failure replaces the last. */
const TOAST_ID = "capture-failed";

const KEYS: Record<string, string> = {
  capture_denied: "capture.perm.body",
  capture_no_tool: "capture.err.noTool",
  capture_timeout: "capture.err.timeout",
  capture_busy: "capture.err.busy",
  too_large: "capture.err.tooLarge",
  shortcut_taken: "capture.err.shortcutTaken",
};

/** The i18n key of a capture error code; `capture.err.failed` for any other. */
export function captureErrorKey(code: string): string {
  return KEYS[code] ?? "capture.err.failed";
}

type CaptureToastApi = Pick<Api, "captureOpenPrivacy">;

function toastFailure(api: CaptureToastApi, t: I18n["t"], code: string): void {
  pushToast({
    id: TOAST_ID,
    text: t(captureErrorKey(code)),
    // Denied screen recording is fixed in System Settings, so the toast opens it.
    actions: code === "capture_denied" ? [{ label: t("capture.perm.open"), run: () => void api.captureOpenPrivacy().catch(() => undefined) }] : [],
  });
}

/** Starts a capture (the palette action); a refusal, such as one already running, is a toast. */
export function startCapture(api: Pick<Api, "captureStart"> & CaptureToastApi, t: I18n["t"]): void {
  void api.captureStart().catch((e) => toastFailure(api, t, toApiError(e).code));
}

/** Shows every `capture://failed` as a toast, wherever the capture was started from. */
export function useCaptureFailures(api: Pick<Api, "onCaptureFailed"> & CaptureToastApi): void {
  const { t } = useI18n();
  // The listener binds once; the text follows the language through the ref.
  const tr = useRef(t);
  tr.current = t;
  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    void api.onCaptureFailed((e) => toastFailure(api, tr.current, e.code)).then((off) => {
      if (live) stop = off;
      else off();
    });
    return () => {
      live = false;
      stop?.();
    };
  }, [api]);
}
