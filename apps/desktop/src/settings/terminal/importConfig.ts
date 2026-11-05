import type { TermConfigPreview, TerminalSettings } from "@/api";

/** The settings a config can set, in the order the dialog lists them; `colors` is the scheme. */
export type ConfigRowId = "fontFamily" | "fontSize" | "cursorStyle" | "cursorBlink" | "scrollback" | "paddingPx" | "backgroundOpacity" | "colors";

export type ConfigRow = {
  id: ConfigRowId;
  /** The current value; `null` stands for "default" or "none" and the dialog words it. */
  from: string | boolean | null;
  to: string | boolean;
};

const FIELDS = ["fontFamily", "fontSize", "cursorStyle", "cursorBlink", "scrollback", "paddingPx", "backgroundOpacity"] as const;

/** Every setting the config sets to something other than what is stored now. */
export function configRows(current: TerminalSettings, preview: TermConfigPreview, currentSchemeName: string | null): ConfigRow[] {
  const rows: ConfigRow[] = [];
  for (const id of FIELDS) {
    const next = preview[id];
    if (next === null || next === current[id]) continue;
    const from = current[id];
    rows.push({ id, from: from === "" ? null : typeof from === "number" ? String(from) : from, to: typeof next === "number" ? String(next) : next });
  }
  if (preview.scheme && preview.scheme.id !== current.theme) {
    rows.push({ id: "colors", from: currentSchemeName, to: preview.scheme.name });
  }
  return rows;
}

/** What Apply writes: the checked settings, and whether the colours are saved as a scheme first. */
export function configChange(preview: TermConfigPreview, checked: ReadonlySet<ConfigRowId>): { change: Partial<TerminalSettings>; saveScheme: boolean } {
  const change: Partial<TerminalSettings> = {};
  if (checked.has("fontFamily") && preview.fontFamily !== null) change.fontFamily = preview.fontFamily;
  if (checked.has("fontSize") && preview.fontSize !== null) change.fontSize = preview.fontSize;
  if (checked.has("cursorStyle") && preview.cursorStyle !== null) change.cursorStyle = preview.cursorStyle;
  if (checked.has("cursorBlink") && preview.cursorBlink !== null) change.cursorBlink = preview.cursorBlink;
  if (checked.has("scrollback") && preview.scrollback !== null) change.scrollback = preview.scrollback;
  if (checked.has("paddingPx") && preview.paddingPx !== null) change.paddingPx = preview.paddingPx;
  if (checked.has("backgroundOpacity") && preview.backgroundOpacity !== null) change.backgroundOpacity = preview.backgroundOpacity;
  return { change, saveScheme: checked.has("colors") && preview.scheme !== null };
}
