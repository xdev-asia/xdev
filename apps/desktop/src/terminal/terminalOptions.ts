import type { ITerminalOptions } from "@xterm/xterm";
import type { TerminalSettings } from "@/api";
import { terminalTheme, type TerminalScheme } from "./terminalThemes";

type LiveOptions = Required<
  Pick<
    ITerminalOptions,
    | "fontFamily"
    | "fontSize"
    | "fontWeight"
    | "lineHeight"
    | "cursorStyle"
    | "cursorBlink"
    | "scrollback"
    | "theme"
    | "wordSeparator"
    | "scrollSensitivity"
    | "fastScrollSensitivity"
    | "minimumContrastRatio"
    | "fontWeightBold"
    | "scrollOnUserInput"
    | "allowTransparency"
  >
>;

/** `#rgb` or `#rrggbb` with an alpha byte for `opacity` (0..1); any other colour is returned as it is. */
export function withAlpha(colour: string | undefined, opacity: number): string | undefined {
  if (!colour || opacity >= 1) return colour;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(colour.trim());
  if (!m) return colour;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  const alpha = Math.round(Math.min(Math.max(opacity, 0), 1) * 255).toString(16).padStart(2, "0");
  return `#${hex}${alpha}`;
}

/** The theme id a mode uses: the light one only when the person asked for a separate light theme. */
export function themeIdFor(s: TerminalSettings, light: boolean): string {
  return light && s.themeFollowApp ? s.themeLight : s.theme;
}

/**
 * The xterm options a `TerminalSettings` sets. An empty family falls back to the `--x-font-mono`
 * token; `token` reads a CSS custom property for the `app` theme; `custom` is the imported schemes.
 */
export function xtermOptions(
  s: TerminalSettings,
  mono: string | undefined,
  token: (name: string) => string | undefined,
  custom: readonly TerminalScheme[] = [],
  light = false,
): LiveOptions {
  const theme = terminalTheme(themeIdFor(s, light), token, custom);
  if (s.backgroundOpacity < 1) theme.background = withAlpha(theme.background, s.backgroundOpacity);
  return {
    fontFamily: s.fontFamily.trim() || mono || "monospace",
    fontSize: s.fontSize,
    fontWeight: s.fontWeight === "medium" ? "500" : s.fontWeight,
    lineHeight: s.lineHeight,
    cursorStyle: s.cursorStyle,
    cursorBlink: s.cursorBlink,
    scrollback: s.scrollback,
    theme,
    wordSeparator: s.wordSeparators,
    scrollSensitivity: s.scrollSensitivity,
    fastScrollSensitivity: s.fastScrollSensitivity,
    minimumContrastRatio: s.minimumContrast,
    fontWeightBold: s.fontWeightBold,
    scrollOnUserInput: s.scrollOnInput,
    allowTransparency: s.backgroundOpacity < 1,
  };
}

/**
 * The text of an OSC 52 write request (`c;<base64>`), or null when it is a read request (`?`) or
 * not valid base64. Reads are never answered: a program must not see what the person copied.
 */
export function decodeOsc52Write(data: string): string | null {
  const at = data.indexOf(";");
  if (at < 0) return null;
  const payload = data.slice(at + 1).trim();
  if (!payload || payload === "?") return null;
  try {
    const bin = atob(payload);
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}
