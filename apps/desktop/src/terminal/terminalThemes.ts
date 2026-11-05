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

/**
 * A bundled scheme, else an imported one (`custom`). "app" or an unknown id: only background and
 * foreground, from the xDev tokens (today's look).
 */
export function terminalTheme(id: string, token: (name: string) => string | undefined, custom: readonly TerminalScheme[] = []): ITheme {
  const scheme = TERMINAL_SCHEMES.find((s) => s.id === id) ?? custom.find((s) => s.id === id);
  if (scheme) return { ...scheme.colors };
  return { background: token("--x-color-surface"), foreground: token("--x-color-ink") };
}
