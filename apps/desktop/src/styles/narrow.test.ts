import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const read = (name: string): string => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
const workspace = read("workspace.css");
const settings = read("settings.css");

/** The body of the first @media block with this query, braces balanced. */
function media(css: string, query: string): string {
  const start = css.indexOf(`@media (${query})`);
  expect(start, `@media (${query})`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(css.indexOf("{", start) + 1, i);
  }
  throw new Error("unbalanced");
}

it("the header keeps its buttons and language switcher at full size and lets the search give way", () => {
  expect(workspace).toMatch(/\.ws-header\s*>\s*\*[^{]*\{[^}]*flex-shrink:\s*0/);
  expect(workspace).toMatch(/\.ws-header\s*>\s*\.ws-header-center[^{]*\{[^}]*flex-shrink:\s*1/);
  expect(workspace).toMatch(/\.ws-header-center\s*\{[^}]*overflow:\s*hidden/);
  expect(workspace).toMatch(/\.ws-search\s*\{[^}]*min-width:\s*0/);
});

it("the shortcut hint goes when the search box has no room for it", () => {
  expect(workspace).toMatch(/\.ws-header-center\s*\{[^}]*container-type:\s*inline-size/);
  expect(workspace).toMatch(/@container\s*\(max-width:\s*\d+px\)\s*\{[^}]*\.ws-search-hint\s*\{[^}]*display:\s*none/);
});

it("a narrow window drops the brand and crumbs, floats the sidebar and stacks Settings", () => {
  const narrow = media(workspace, "max-width: 600px");
  expect(narrow).toMatch(/\.ws-brand[^{]*\{[^}]*display:\s*none/);
  expect(narrow).toMatch(/\.ws-crumb[^{]*\{[^}]*display:\s*none/);
  expect(narrow).toMatch(/\.ws-sidebar\s*\{[^}]*position:\s*absolute/);
  const stacked = media(settings, "max-width: 600px");
  expect(stacked).toMatch(/\.settings\s*\{[^}]*flex-direction:\s*column/);
  expect(stacked).toMatch(/\.settings-nav\s*\{[^}]*width:\s*auto/);
  // A row's actions (docs, switch, Edit) go under its name at 360px.
  expect(stacked).toMatch(/\.settings-item\s*\{[^}]*flex-wrap:\s*wrap/);
});

it("the file viewers wrap their toolbars and fix no width past 360px", () => {
  const files = read("preview-files.css");
  expect(files).toMatch(/\.media-bar\s*\{[^}]*flex-wrap:\s*wrap/);
  expect(files).toMatch(/\.md-pane-bar\s*\{[^}]*flex-wrap:\s*wrap/);
  expect(files).toMatch(/\.md-toc\s*\{[^}]*max-width:\s*40%/);
  const fixed = [...files.matchAll(/(?<![-\w])(?:min-)?width:\s*(\d+)px/g)].map((m) => Number(m[1]));
  expect(fixed.filter((px) => px > 360)).toEqual([]);
});
