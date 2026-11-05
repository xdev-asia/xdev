import type { EditorSettings } from "@/api";

// `EditorSettings::default()` in Rust; used until the stored settings load, or when they cannot.
// A Rust test reads this file, so keep one `key: value,` per line.
export const EDITOR_DEFAULTS: EditorSettings = {
  autosave: false,
  autosaveMs: 1000,
  fontSize: 13,
  fontFamily: "",
  wordWrap: true,
  tabSize: 4,
};

// The ranges Rust clamps a stored value to (`EditorSettings::clamped`).
export const EDITOR_LIMITS = {
  autosaveMs: { min: 250, max: 10000 },
  fontSize: { min: 8, max: 32 },
  tabSize: { min: 1, max: 8 },
} as const;

const clamp = (n: number, { min, max }: { min: number; max: number }) => Math.max(min, Math.min(max, Math.round(n)));

/** What Rust stores for `s`: whole numbers inside their ranges. */
export function clampEditorSettings(s: EditorSettings): EditorSettings {
  return {
    ...s,
    autosaveMs: clamp(s.autosaveMs, EDITOR_LIMITS.autosaveMs),
    fontSize: clamp(s.fontSize, EDITOR_LIMITS.fontSize),
    tabSize: clamp(s.tabSize, EDITOR_LIMITS.tabSize),
  };
}
