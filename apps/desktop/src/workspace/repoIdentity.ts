/** `REPO_COLORS` in Rust: the names a project colour can take; each has a `--x-color-tag-<name>` token. */
export const REPO_COLORS = ["slate", "red", "orange", "yellow", "green", "teal", "violet", "pink"] as const;

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** `#rgb` or `#rrggbb`, the custom colour spelling Rust accepts. */
export function isHexColor(text: string): boolean {
  return HEX.test(text);
}

/** `#rgb` as `#rrggbb`, lower case; a valid `#rrggbb` is only lower-cased. */
export function widenHex(hex: string): string {
  const h = hex.slice(1).toLowerCase();
  return h.length === 3 ? `#${[...h].map((c) => c + c).join("")}` : `#${h}`;
}

/** The ink tone that reads on a custom fill: dark on a light one, light on a dark one (relative luminance of the sRGB hex). */
export function hexInk(hex: string): "dark" | "light" {
  const full = widenHex(hex).slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179 ? "dark" : "light";
}
