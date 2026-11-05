import { expect, it } from "vitest";
import { clampTintOpacity, SIDEBAR_TINTS, sidebarTintValue, TINT_OPACITY } from "./sidebarTint";

it("builds the wash from the token variable and the sidebar ground", () => {
  expect(sidebarTintValue("accent", 0.1)).toBe("color-mix(in srgb, var(--accent) 10%, var(--bg-1))");
  expect(sidebarTintValue("text-2", 0.25)).toBe("color-mix(in srgb, var(--text-2) 25%, var(--bg-1))");
});

it("never builds a colour literal", () => {
  for (const name of SIDEBAR_TINTS) expect(sidebarTintValue(name, 0.3)).not.toMatch(/#|rgb\(|hsl\(/);
});

it("gives nothing for no tint or an unknown name", () => {
  expect(sidebarTintValue("", 0.1)).toBeNull();
  expect(sidebarTintValue("red; background: url(x)", 0.1)).toBeNull();
});

it("keeps the strength inside its range", () => {
  expect(clampTintOpacity(0)).toBe(TINT_OPACITY.min);
  expect(clampTintOpacity(0.9)).toBe(TINT_OPACITY.max);
  expect(clampTintOpacity(0.123)).toBe(0.12);
  expect(clampTintOpacity(Number.NaN)).toBe(TINT_OPACITY.default);
  expect(sidebarTintValue("ok", 5)).toContain(" 30%");
});
