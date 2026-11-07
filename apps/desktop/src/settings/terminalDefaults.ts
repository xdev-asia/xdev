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
  service: true,
  onQuit: "keep",
  ringMb: 2,
  saveScrollback: true,
  theme: "app",
  gpu: "auto",
  bell: "none",
  wordSeparators: " ()[]{}',\"`",
  scrollSensitivity: 1.15,
  fastScrollSensitivity: 5,
  minimumContrast: 1,
  focusFollowsMouse: false,
  middleClickPaste: false,
  linkClick: "actions",
  urlMiddleClick: "open",
  macOptionAsAlt: "auto",
  themeLight: "one-light",
  themeFollowApp: false,
  dimInactivePanes: false,
  paneDividerPx: 1,
  fontWeightBold: "bold",
  scrollOnInput: true,
  paddingPx: 8,
  backgroundOpacity: 1,
  shellIntegration: true,
  tuiScrollSensitivity: 1,
  copyTrimsGutter: true,
  maxRunningTerminals: 256,
  windowsPowershell: "auto",
  macJisYenToBackslash: false,
};

// The double-click word separators when none are set (`DEFAULT_WORD_SEPARATORS` in Rust).
export const DEFAULT_WORD_SEPARATORS = " ()[]{}',\"`";

// The ranges Rust clamps a stored value to (`TerminalSettings::clamped`).
export const TERMINAL_LIMITS = {
  fontSize: { min: 8, max: 32 },
  lineHeight: { min: 1, max: 2 },
  scrollback: { min: 0, max: 100000 },
  ringMb: { min: 1, max: 16 },
  scrollSensitivity: { min: 0.5, max: 3 },
  fastScrollSensitivity: { min: 1, max: 10 },
  minimumContrast: { min: 1, max: 21 },
  paneDividerPx: { min: 1, max: 4 },
  paddingPx: { min: 0, max: 24 },
  backgroundOpacity: { min: 0.5, max: 1 },
  tuiScrollSensitivity: { min: 1, max: 10 },
  maxRunningTerminals: { min: 1, max: 1024 },
} as const;

const clamp = (n: number, { min, max }: { min: number; max: number }) => Math.max(min, Math.min(max, n));
// NaN reads as the default, as in Rust.
const clampOr = (n: number, range: { min: number; max: number }, fallback: number) =>
  Number.isFinite(n) ? clamp(n, range) : fallback;

// The theme id that means the xDev tokens (`THEME_APP` in Rust).
export const THEME_APP = "app";

const THEME_ID = /^[a-z0-9-]{1,40}$/;
// Control characters (C0, DEL, C1) are dropped, as in Rust.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** What Rust stores for `s`: numbers inside their ranges, whole where Rust keeps integers. */
export function clampTerminalSettings(s: TerminalSettings): TerminalSettings {
  return {
    ...s,
    fontSize: clamp(Math.round(s.fontSize), TERMINAL_LIMITS.fontSize),
    lineHeight: clamp(s.lineHeight, TERMINAL_LIMITS.lineHeight),
    scrollback: clamp(Math.round(s.scrollback), TERMINAL_LIMITS.scrollback),
    ringMb: clamp(Math.round(s.ringMb), TERMINAL_LIMITS.ringMb),
    theme: THEME_ID.test(s.theme) ? s.theme : TERMINAL_DEFAULTS.theme,
    wordSeparators: [...s.wordSeparators.replace(CONTROL, "")].slice(0, 64).join("") || DEFAULT_WORD_SEPARATORS,
    scrollSensitivity: clampOr(s.scrollSensitivity, TERMINAL_LIMITS.scrollSensitivity, TERMINAL_DEFAULTS.scrollSensitivity),
    fastScrollSensitivity: clampOr(
      s.fastScrollSensitivity,
      TERMINAL_LIMITS.fastScrollSensitivity,
      TERMINAL_DEFAULTS.fastScrollSensitivity,
    ),
    minimumContrast: clampOr(s.minimumContrast, TERMINAL_LIMITS.minimumContrast, TERMINAL_DEFAULTS.minimumContrast),
    themeLight: THEME_ID.test(s.themeLight) ? s.themeLight : TERMINAL_DEFAULTS.themeLight,
    paneDividerPx: clamp(Math.round(s.paneDividerPx), TERMINAL_LIMITS.paneDividerPx),
    paddingPx: clamp(Math.round(s.paddingPx), TERMINAL_LIMITS.paddingPx),
    backgroundOpacity: clampOr(s.backgroundOpacity, TERMINAL_LIMITS.backgroundOpacity, TERMINAL_DEFAULTS.backgroundOpacity),
    tuiScrollSensitivity: clampOr(
      Math.round(s.tuiScrollSensitivity),
      TERMINAL_LIMITS.tuiScrollSensitivity,
      TERMINAL_DEFAULTS.tuiScrollSensitivity,
    ),
    maxRunningTerminals: clamp(Math.round(s.maxRunningTerminals), TERMINAL_LIMITS.maxRunningTerminals),
  };
}
