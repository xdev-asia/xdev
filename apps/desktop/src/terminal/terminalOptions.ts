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
  >
>;

/**
 * The xterm options a `TerminalSettings` sets. An empty family falls back to the `--x-font-mono`
 * token; `token` reads a CSS custom property for the `app` theme; `custom` is the imported schemes.
 */
export function xtermOptions(
  s: TerminalSettings,
  mono: string | undefined,
  token: (name: string) => string | undefined,
  custom: readonly TerminalScheme[] = [],
): LiveOptions {
  return {
    fontFamily: s.fontFamily.trim() || mono || "monospace",
    fontSize: s.fontSize,
    fontWeight: s.fontWeight === "medium" ? "500" : s.fontWeight,
    lineHeight: s.lineHeight,
    cursorStyle: s.cursorStyle,
    cursorBlink: s.cursorBlink,
    scrollback: s.scrollback,
    theme: terminalTheme(s.theme, token, custom),
    wordSeparator: s.wordSeparators,
    scrollSensitivity: s.scrollSensitivity,
    fastScrollSensitivity: s.fastScrollSensitivity,
    minimumContrastRatio: s.minimumContrast,
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
