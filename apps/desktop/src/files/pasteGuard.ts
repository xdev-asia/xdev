import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** The largest paste the editor takes, in UTF-8 bytes. */
export const PASTE_MAX_BYTES = 16 * 1024 * 1024;

// A UTF-8 sequence is at most 3 bytes per UTF-16 unit, so a text shorter than a third of the cap
// cannot be over it and a text longer than the cap in units is over it: both skip the count.
export function pasteTooLarge(text: string): boolean {
  if (text.length > PASTE_MAX_BYTES) return true;
  if (text.length * 3 <= PASTE_MAX_BYTES) return false;
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      // A surrogate pair is one 4-byte character.
      bytes += 4;
      i++;
    } else bytes += 3;
    if (bytes > PASTE_MAX_BYTES) return true;
  }
  return false;
}

/** The paste handler: true (handled, nothing inserted) when the text is over the cap. */
export function pasteHandler(onTooLarge: () => void): (event: ClipboardEvent, view: EditorView) => boolean {
  return (event) => {
    // Empty where the platform hides it: the paste goes through.
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (!pasteTooLarge(text)) return false;
    event.preventDefault();
    onTooLarge();
    return true;
  };
}

/** Refuses a paste over `PASTE_MAX_BYTES` and calls `onTooLarge`. */
export function pasteGuard(onTooLarge: () => void): Extension {
  return EditorView.domEventHandlers({ paste: pasteHandler(onTooLarge) });
}
