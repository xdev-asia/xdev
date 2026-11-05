import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./workspace.css", import.meta.url)), "utf8");

it("the tinted sidebar rule paints the sidebar with the side-tint token", () => {
  const rule = css.match(/\[data-sidebar="tinted"\]\s+\.ws-sidebar\s*\{([^}]*)\}/);
  expect(rule?.[1]).toMatch(/background:\s*var\(--side-tint\)/);
});
