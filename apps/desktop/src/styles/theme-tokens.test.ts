import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Every `var(--x)` the app uses must exist in the dark and the light theme, or the app would paint a
// default (usually nothing) in one of them. Plain fs and regex; the tokens are xdev-ui's generated CSS.
const src = fileURLToPath(new URL("../", import.meta.url));
const tokensCss = fileURLToPath(new URL("../../../../packages/xdev-ui/src/styles/tokens.css", import.meta.url));

/**
 * Variables the app sets itself, on an element or in its own CSS, so they are not tokens. Each one is
 * set inline (React `style`) or in a rule next to where it is read.
 */
const LOCAL = new Set([
  "--agent-size", // agents.css: the size of the agent mark in a row
  "--editor-font-size", // files/CodeEditor.tsx sets it inline from the editor font size; Editor.tsx falls back to 13px
  "--editor-font-family", // files/CodeEditor.tsx sets it inline from `editorFontStack`; Editor.tsx falls back to the mono token
  "--tree-indent", // the file tree: indent per level
  "--tree-pad", // the file tree: left padding of a row
  "--ws-strip-h", // workspace.css: height of the tab strip
  "--ws-pane-line", // PaneView sets it on the root: pane divider thickness
  "--ws-pane-inset", // PaneView sets it on the root: divider thickness above 1px
  "--ws-tab-color", // workspace/TabStrip.tsx sets it inline to a `--x-tab-color-*` token
  // workspace.css `.ws-shell`: project colours (RepoBadge), each an alias over palette tokens, so both themes follow.
  ...["slate", "red", "orange", "yellow", "green", "teal", "violet", "pink"].map((c) => `--x-color-tag-${c}`),
]);

function sources(): string[] {
  return (readdirSync(src, { recursive: true }) as string[])
    .filter((f) => /\.(ts|tsx|css)$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => join(src, f));
}

/** Names defined per theme: the shared block counts for both; `:root,[data-theme="dark"]` is dark. */
function definitions(): { dark: Set<string>; light: Set<string> } {
  const css = readFileSync(tokensCss, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const dark = new Set<string>();
  const light = new Set<string>();
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const names = [...body.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]);
    const isLight = selector.includes('[data-theme="light"]');
    const isDark = selector.includes('[data-theme="dark"]');
    for (const n of names) {
      if (isLight || !isDark) light.add(n);
      if (isDark || !isLight) dark.add(n);
    }
  }
  return { dark, light };
}

it("every var(--x) the app uses is defined in both themes, or is a listed local", () => {
  const { dark, light } = definitions();
  expect(dark.size, "tokens.css not generated? run `pnpm --filter @xdev-asia/ui tokens`").toBeGreaterThan(20);
  const used = new Map<string, string>();
  for (const file of sources()) {
    for (const m of readFileSync(file, "utf8").matchAll(/var\(\s*(--[A-Za-z0-9_-]+)(?![A-Za-z0-9_$-])/g)) {
      if (!used.has(m[1])) used.set(m[1], file.slice(src.length).replaceAll("\\", "/"));
    }
  }
  const missing = [...used]
    .filter(([name]) => !LOCAL.has(name) && !(dark.has(name) && light.has(name)))
    .map(([name, file]) => `${name} (first used in ${file}): dark=${dark.has(name)} light=${light.has(name)}`);
  expect(missing).toEqual([]);
});

it("the local allowlist holds only variables the app still uses and the tokens do not define", () => {
  const { dark, light } = definitions();
  const text = sources().map((f) => readFileSync(f, "utf8")).join("\n");
  const stale = [...LOCAL].filter((name) => !text.includes(name) || dark.has(name) || light.has(name));
  expect(stale).toEqual([]);
});

it("the dark and the light theme define the same names", () => {
  const { dark, light } = definitions();
  expect([...dark].filter((n) => !light.has(n))).toEqual([]);
  expect([...light].filter((n) => !dark.has(n))).toEqual([]);
});
