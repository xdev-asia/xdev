import { describe, expect, it } from "vitest";
import { tokens, tokensCss } from "./tokens";

describe("tokens", () => {
  it("light and dark define the same color keys", () => {
    expect(Object.keys(tokens.color.dark).sort()).toEqual(Object.keys(tokens.color.light).sort());
  });

  it("light and dark define the same graphite keys", () => {
    expect(Object.keys(tokens.graphite.dark).sort()).toEqual(Object.keys(tokens.graphite.light).sort());
  });

  it("tokensCss contains --x-color-accent for both modes", () => {
    const css = tokensCss();
    expect(css).toContain(`--x-color-accent:${tokens.color.light.accent};`);
    expect(css).toContain(`--x-color-accent:${tokens.color.dark.accent};`);
    expect(css).toContain(':root:not([data-theme="light"])');
    expect(css).toContain(':root[data-theme="dark"]');
  });

  it("tokensCss contains the graphite neutrals for both modes", () => {
    const css = tokensCss();
    expect(css).toContain(`--x-graphite-bg:${tokens.graphite.light.bg};`);
    expect(css).toContain(`--x-graphite-bg:${tokens.graphite.dark.bg};`);
    expect(css).toContain(`--x-graphite-term:${tokens.graphite.dark.term};`);
  });

  it("tokensCss exposes space, radius and font", () => {
    const css = tokensCss();
    expect(css).toContain("--x-space-4:16px;");
    expect(css).toContain("--x-radius-md:8px;");
    expect(css).toContain("--x-font-mono:");
  });
});
