import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandMark } from "./BrandMark";

describe("BrandMark", () => {
  it("renders an inline, decorative svg that follows currentColor", () => {
    const markup = renderToStaticMarkup(<BrandMark size={18} className="ws-logo" />);
    expect(markup).toMatch(/^<svg /);
    expect(markup).toContain('width="18"');
    expect(markup).toContain('height="18"');
    expect(markup).toContain('class="ws-logo"');
    expect(markup).toContain('fill="currentColor"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain("<img");
  });

  it("matches the geometry of the brand asset", () => {
    const asset = readFileSync(new URL("../../../../docs/brand/xdev-mark.svg", import.meta.url), "utf8");
    const markup = renderToStaticMarkup(<BrandMark size={16} />);
    for (const d of asset.matchAll(/ d="([^"]+)"/g)) expect(markup).toContain(`d="${d[1]}"`);
  });

  it("is the only logo the shell, docs app and vault view use", () => {
    for (const file of ["../workspace/WorkspaceShell.tsx", "../DocsApp.tsx", "./NoVaultView.tsx"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/<img[^>]*logo/);
      expect(source, file).not.toContain("xdev-icon-512.png");
      expect(source, file).toContain("<BrandMark");
    }
  });
});
