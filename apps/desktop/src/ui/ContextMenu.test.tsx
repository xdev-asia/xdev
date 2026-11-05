import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MenuPanel, type MenuItem } from "./ContextMenu";

const t = (key: string) => key.toUpperCase();
const items: MenuItem[] = [
  { id: "copy", labelKey: "copy", chord: "Ctrl+C" },
  { id: "paste", labelKey: "paste", disabled: true },
  { id: "sep", labelKey: "", kind: "separator" },
  { id: "close", labelKey: "close", danger: true },
  { id: "color", labelKey: "color", children: [{ id: "c1", labelKey: "red", swatch: "--x-tab-color-1", checked: true }] },
];
const html = (path: number[]) => renderToStaticMarkup(<MenuPanel items={items} path={path} t={t} />);

it("renders menu items with roles, chord and separators", () => {
  const out = html([0]);
  expect(out.match(/role="menuitem"/g)).toHaveLength(4);
  expect(out).toContain('role="separator"');
  expect(out).toContain('<span class="x-menu-chord">Ctrl+C</span>');
  expect(out).toContain("COPY");
});

it("marks the active, disabled and danger items", () => {
  const out = html([0]);
  expect(out).toMatch(/data-path="0"[^>]*data-active="true"/);
  expect(out).toMatch(/aria-disabled="true"[^>]*>.*PASTE/);
  expect(out).toContain('data-danger="true"');
});

it("opens the submenu of the active parent, with swatch and radio state", () => {
  expect(html([4])).not.toContain("x-menu-sub");
  const out = html([4, 0]);
  expect(out).toContain("x-menu-sub");
  expect(out).toContain('role="menuitemradio"');
  expect(out).toContain('aria-checked="true"');
  expect(out).toContain("background:var(--x-tab-color-1)");
  expect(out).toContain('aria-haspopup="menu"');
});

it("draws a title above the rows that is not an item", () => {
  const out = renderToStaticMarkup(<MenuPanel items={items} path={[0]} t={t} title="src/a.ts:3" />);
  expect(out.startsWith('<div class="x-menu-group term-link-dest" role="presentation" title="src/a.ts:3">src/a.ts:3</div>')).toBe(true);
  expect(out.match(/role="menuitem"/g)).toHaveLength(4);
  expect(out.match(/data-path=/g)).toHaveLength(4);
  // A submenu does not repeat it.
  expect(renderToStaticMarkup(<MenuPanel items={items} path={[4, 0]} t={t} title="x" />).match(/term-link-dest/g)).toHaveLength(1);
});
