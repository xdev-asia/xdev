import type { TerminalSettings } from "@/api";
import { IS_MAC } from "@/platform";

// `TerminalSettings::default()` in Rust; used until the stored settings load, or when they cannot.
// A Rust test reads this file, so keep one `key: value,` per line.
export const TERMINAL_DEFAULTS: TerminalSettings = {
  fontFamily: "",
  fontSize: 13,
  fontWeight: "normal",
  lineHeight: 1,
  cursorStyle: "block",
  cursorBlink: true,
  scrollback: 10000,
  copyOnSelect: true,
  rightClickPaste: !IS_MAC,
  osc52Clipboard: true,
};

// The ranges Rust clamps a stored value to (`TerminalSettings::clamped`).
export const TERMINAL_LIMITS = {
  fontSize: { min: 8, max: 32 },
  lineHeight: { min: 1, max: 2 },
  scrollback: { min: 0, max: 100000 },
} as const;

const clamp = (n: number, { min, max }: { min: number; max: number }) => Math.max(min, Math.min(max, n));

/** What Rust stores for `s`: numbers inside their ranges, whole where Rust keeps integers. */
export function clampTerminalSettings(s: TerminalSettings): TerminalSettings {
  return {
    ...s,
    fontSize: clamp(Math.round(s.fontSize), TERMINAL_LIMITS.fontSize),
    lineHeight: clamp(s.lineHeight, TERMINAL_LIMITS.lineHeight),
    scrollback: clamp(Math.round(s.scrollback), TERMINAL_LIMITS.scrollback),
  };
}
