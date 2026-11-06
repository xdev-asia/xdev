import type { ITheme } from "@xterm/xterm";
import schemes from "./terminalThemes.json";

// The palettes are data in `terminalThemes.json` (source and licence of each are in that file and in
// `terminalThemes.NOTICE.md`), so no colour literal sits in a code file.

export type TerminalPalette = {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
};

export type TerminalScheme = { id: string; name: string; mode: "dark" | "light"; colors: TerminalPalette };

export const TERMINAL_SCHEMES: readonly TerminalScheme[] = schemes.map(({ id, name, mode, colors }) => ({
  id,
  name,
  mode: mode as TerminalScheme["mode"],
  colors,
}));

const ANSI = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;

/** The bundled schemes whose 16 ANSI colours the "app" look borrows, by mode. */
export const APP_ANSI_SOURCE = { light: "github-light", dark: "github-dark" } as const;

/**
 * A bundled scheme, else an imported one (`custom`). "app" or an unknown id: background, foreground
 * and cursor from the xDev tokens, and the 16 ANSI colours of a bundled scheme for the mode, so
 * program output (yellow, bright white...) stays readable on the light tokens too.
 */
export function terminalTheme(
  id: string,
  token: (name: string) => string | undefined,
  custom: readonly TerminalScheme[] = [],
  light = false,
): ITheme {
  const scheme = TERMINAL_SCHEMES.find((s) => s.id === id) ?? custom.find((s) => s.id === id);
  if (scheme) return { ...scheme.colors };
  const source = TERMINAL_SCHEMES.find((s) => s.id === APP_ANSI_SOURCE[light ? "light" : "dark"]);
  const theme: ITheme = { background: token("--x-color-surface"), foreground: token("--x-color-ink") };
  if (source) {
    for (const key of ANSI) theme[key] = source.colors[key];
    theme.selectionBackground = source.colors.selectionBackground;
  }
  const cursor = token("--x-color-signal");
  if (cursor) theme.cursor = cursor;
  return theme;
}
