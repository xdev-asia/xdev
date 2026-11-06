import { toApiError, type Api } from "@/api";
import type { I18n } from "@/i18n";
import { pushToast } from "@/workspace/toastStore";

/** What the mounted `CaptureHost` offers the rest of the app. */
export interface Annotator {
  /** Opens the dialog on a saved PNG. Resolves the path to use, or null when the person discards it. */
  open(path: string, mode: "paste" | "send"): Promise<string | null>;
  /** Whether a pasted image should open the dialog first (`capture.annotatePaste`). */
  pasteEnabled(): Promise<boolean>;
}

let annotator: Annotator | null = null;

/** The host registers itself while it is mounted; returns the unregister. */
export function registerAnnotator(a: Annotator): () => void {
  annotator = a;
  return () => {
    if (annotator === a) annotator = null;
  };
}

/** The terminal paste hook: the pasted image's path as annotated, the same path when the setting is off, null for a discard. */
export async function annotatePasted(path: string): Promise<string | null> {
  const a = annotator;
  if (!a) return path;
  try {
    if (!(await a.pasteEnabled())) return path;
  } catch {
    return path;
  }
  return a.open(path, "paste");
}

/** The palette action: the clipboard image opens in the dialog; with none, a toast says so. */
export async function annotateClipboard(api: Pick<Api, "clipboardImageSave">, t: I18n["t"]): Promise<void> {
  try {
    const path = await api.clipboardImageSave();
    if (path === null) return void pushToast({ text: t("capture.noClipboardImage") });
    if (!annotator) return;
    await annotator.open(path, "send");
  } catch (e) {
    pushToast({ text: toApiError(e).code === "too_large" ? t("capture.err.tooLarge") : t("capture.err.failed") });
  }
}
