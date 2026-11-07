import { beforeEach, expect, it, vi } from "vitest";
import type { JSX } from "react";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { resetBindingsForTests, setKeybindingsText } from "@/keys/bindingsStore";
import { mount, tick } from "@/kit/testHooks";
import { createMockKeybindings, MOCK_KEYBINDINGS_PATH } from "@/mockKeybindings";
import type { SettingsSectionProps } from "@/settings/sections";
import { ShortcutsPage } from "./ShortcutsPage";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const en = (key: string) => translate("en", key);
type Item = { type?: string; label?: string; onSelect?: () => void };
type Found = { props: Record<string, any> };

function open(over: Partial<ReturnType<typeof createMockKeybindings>> = {}) {
  resetBindingsForTests();
  const kb = createMockKeybindings(null);
  const api = { ...createMockApi({}), ...kb, ...over };
  const page = ShortcutsPage as (props: SettingsSectionProps) => JSX.Element;
  const m = mount(page, () => ({ api, onChanged() {}, arg: undefined }) as unknown as SettingsSectionProps);
  const menu = () => (m.all() as Found[]).find((n) => Array.isArray(n.props.items) && n.props.label === en("keys.page.fileMenu"));
  const items = () => menu()!.props.items as Item[];
  const select = (label: string) => items().find((i) => i.label === label)!.onSelect!();
  return { m, kb, menu, items, select };
}

beforeEach(() => resetBindingsForTests());

it("the file menu lists the items in order, with a separator before Reveal", async () => {
  const { m, items } = open();
  await m.settle();
  expect(items().map((i) => i.label ?? i.type)).toEqual([
    en("keys.page.openDefault"),
    en("keys.page.openVsCode"),
    en("keys.page.openCursor"),
    "separator",
    en("keys.page.revealFile"),
    en("keys.page.reload"),
  ]);
});

it("each item calls its own api method", async () => {
  const { m, kb, select } = open();
  await m.settle();
  select(en("keys.page.openDefault"));
  select(en("keys.page.openVsCode"));
  select(en("keys.page.openCursor"));
  select(en("keys.page.revealFile"));
  await tick();
  expect(kb.__opens()).toEqual([null, "code", "cursor"]);
  expect(kb.__revealFiles()).toBe(1);
});

it("Reload reads the file again and shows an outside edit", async () => {
  const { m, kb, select } = open();
  await m.settle();
  setKeybindingsText('{"version":1,"keybindings":{}}', MOCK_KEYBINDINGS_PATH);
  kb.__editKeybindings('{"version":1,"keybindings":{"tab.new":["Ctrl+Alt+N"]}}');
  select(en("keys.page.reload"));
  await tick();
  const text = JSON.stringify((await m.settle()).map((n) => n.props.children));
  expect(text).toContain("Ctrl+Alt+N");
});

it("a failed editor open shows the editor error line", async () => {
  const { m, select } = open({
    keybindingsOpenWith: vi.fn(async (editor: "code" | "cursor" | null) => {
      if (editor === "cursor") throw { code: "internal" };
    }),
  });
  await m.settle();
  select(en("keys.page.openCursor"));
  await tick();
  const text = JSON.stringify((await m.settle()).map((n) => n.props.children));
  expect(text).toContain("Failed to open external editor.");
});

it("KEY-10: four filter chips with counts, exactly one pressed", async () => {
  const { m } = open();
  const all = await m.settle();
  const chips = (all as Found[]).filter((n) => n.props["aria-pressed"] !== undefined);
  expect(chips).toHaveLength(4);
  expect(chips.filter((n) => n.props["aria-pressed"] === true)).toHaveLength(1);
  const text = JSON.stringify(chips.map((n) => n.props.children));
  for (const f of ["all", "modified", "unassigned", "conflicts"]) expect(text).toContain(en(`keys.page.filter.${f}`));
});
