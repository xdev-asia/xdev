/** Ctrl+Shift+Backspace (Cmd on macOS). */
export function isDeleteKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }, mac: boolean): boolean {
  return e.key === "Backspace" && e.shiftKey && !e.altKey && (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);
}

/** True when the key goes to something that types: a text field, an editable area, or a terminal. */
export function typingIn(target: unknown): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  if (target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], .xterm")) return true;
  return false;
}
