// The phase 1 scratch note lived in localStorage. It is read once and moved into a note tab; the key
// goes only after the first save of `floating.json` that succeeded.
const KEY = "xdev.floating.note.v1";

/** The legacy note's text; empty when there is none or the store cannot be read. */
export function loadLegacyNote(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

/** Removes the legacy key; a store that refuses is left as it is. */
export function clearLegacyNote(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to do: the next start reads it again, and the note tab already exists.
  }
}
