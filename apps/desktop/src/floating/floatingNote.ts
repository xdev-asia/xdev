const KEY = "xdev.floating.note.v1";
const MAX_BYTES = 256 * 1024;

/** The scratch note's saved text; empty when there is none or the store cannot be read. */
export function loadNote(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

/** Saves the text; false when it is over the cap or the store refuses it. */
export function saveNote(text: string): boolean {
  try {
    if (new TextEncoder().encode(text).length > MAX_BYTES) return false;
    localStorage.setItem(KEY, text);
    return true;
  } catch {
    return false;
  }
}
