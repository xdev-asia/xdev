// The tinted sidebar's wash: a token name and a strength become one CSS colour built from the token variable.

/** Token names the tint may use; `UiSettings::SIDEBAR_TINTS` in Rust. */
export const SIDEBAR_TINTS = ["accent", "signal", "violet", "ok", "warn", "orange", "danger", "text-2"] as const;
export type SidebarTint = (typeof SIDEBAR_TINTS)[number];

export const TINT_OPACITY = { min: 0.04, max: 0.3, step: 0.01, default: 0.1 } as const;

/** The strength inside its range, to whole percent; the default when it is no number. */
export function clampTintOpacity(value: number): number {
  if (!Number.isFinite(value)) return TINT_OPACITY.default;
  return Math.round(Math.min(TINT_OPACITY.max, Math.max(TINT_OPACITY.min, value)) * 100) / 100;
}

/** The `--side-tint` value for `name` at `opacity`: the token mixed into the sidebar ground. Null for no or an unknown name. */
export function sidebarTintValue(name: string, opacity: number): string | null {
  if (!(SIDEBAR_TINTS as readonly string[]).includes(name)) return null;
  return `color-mix(in srgb, var(--${name}) ${Math.round(clampTintOpacity(opacity) * 100)}%, var(--bg-1))`;
}
