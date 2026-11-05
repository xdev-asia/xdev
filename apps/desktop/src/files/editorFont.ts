const MONO = "var(--x-font-mono)";
// `UI_FONT_MAX` in Rust.
const FONT_MAX = 120;

// Rust `clean_ui_font`: control characters dropped, trimmed, cut to `FONT_MAX` characters.
function clean(raw: string): string {
  const kept = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  return [...kept.trim()].slice(0, FONT_MAX).join("").trim();
}

/**
 * The editor's `font-family`: its own family, else the terminal's, always ending with the mono
 * token so a family that is not installed still shows a monospace face.
 */
export function editorFontStack(editor: string, terminal: string): string {
  const family = clean(editor) || clean(terminal);
  if (!family) return MONO;
  return family.includes(MONO) ? family : `${family}, ${MONO}`;
}
