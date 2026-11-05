import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RecentTabSwitcher, switcherKey } from "./RecentTabSwitcher";

vi.mock("@/i18n", async (original) => ({
  ...await original<typeof import("@/i18n")>(),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string) => key }),
}));

const items = [
  { id: "t1", title: "Shell", icon: null },
  { id: "file:src/a.ts", title: "a.ts", icon: null, path: "src/a.ts" },
];

it("renders a listbox whose active descendant is the highlighted option, with the file path dimmed", () => {
  const html = renderToStaticMarkup(<RecentTabSwitcher items={items} at={1} steps={2} onCommit={() => {}} onCancel={() => {}} />);
  expect(html).toContain('role="listbox"');
  expect(html).toContain('aria-activedescendant="ws-recent-1"');
  expect(html.match(/role="option"/g)).toHaveLength(2);
  expect(html).toContain('id="ws-recent-1" role="option" aria-selected="true"');
  expect(html).toContain('id="ws-recent-0" role="option" aria-selected="false"');
  expect(html).toContain("x-list-row-meta");
  expect(html).toContain("src/a.ts");
  expect(html).not.toContain("hidden");
});

it("waits to show on the first tab, and shows at once on the second", () => {
  const first = renderToStaticMarkup(<RecentTabSwitcher items={items} at={1} steps={1} onCommit={() => {}} onCancel={() => {}} />);
  expect(first).toContain("hidden");
});

it("keys: Ctrl up commits, Escape cancels, a key without Ctrl commits, Tab with Ctrl is left to the keymap", () => {
  expect(switcherKey({ type: "keyup", key: "Control", ctrlKey: false })).toBe("commit");
  expect(switcherKey({ type: "keyup", key: "Tab", ctrlKey: true })).toBeNull();
  expect(switcherKey({ type: "keydown", key: "Escape", ctrlKey: true })).toBe("cancel");
  expect(switcherKey({ type: "keydown", key: "Escape", ctrlKey: false })).toBe("cancel");
  expect(switcherKey({ type: "keydown", key: "Tab", ctrlKey: true })).toBeNull();
  expect(switcherKey({ type: "keydown", key: "Shift", ctrlKey: true })).toBeNull();
  expect(switcherKey({ type: "keydown", key: "a", ctrlKey: false })).toBe("commit");
});
