/** `APP_ICONS` in Rust, in the picker's order. */
export const APP_ICONS = ["default", "midnight", "light", "sunset", "forest", "mono"] as const;
export type AppIconId = (typeof APP_ICONS)[number];

/** `known_app_icon` in Rust: a known id as is, anything else the default. */
export function knownAppIcon(id: string): AppIconId {
  return (APP_ICONS as readonly string[]).includes(id) ? (id as AppIconId) : "default";
}
