import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./trackers.css", import.meta.url)), "utf8");

/** The body of the first @media block with this query, braces balanced. */
function media(query: string): string {
  const start = css.indexOf(`@media (${query})`);
  expect(start, `@media (${query})`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(css.indexOf("{", start) + 1, i);
  }
  throw new Error("unbalanced");
}

it("the section header wraps at a narrow width", () => {
  expect(css).toMatch(/\.trk-head\s*\{[^}]*flex-wrap:\s*wrap/);
});

it("the Jira fields stack at 600px and below", () => {
  expect(media("max-width: 600px")).toMatch(/\.trk-jira-fields\s*\{[^}]*flex-direction:\s*column/);
});

it("draws no side stripe and no colour literal", () => {
  expect(css).not.toMatch(/border-(left|right|inline-start|inline-end)/);
  expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
});
