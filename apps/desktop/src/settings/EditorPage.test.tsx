import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { EDITOR_DEFAULTS } from "@/files/editorDefaults";
import { getEditorSettings, resetEditorSettingsForTests, startEditorSettingsSync } from "@/files/editorSettings";
import { FontField } from "@xdev-asia/ui";
import { resetTerminalSettingsForTests, setTerminalSettings } from "@/terminal/terminalSettings";
import { TERMINAL_DEFAULTS } from "./terminalDefaults";
import { EditorPage } from "./EditorPage";

const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const state = (initial: unknown) => {
    const index = hooks.cursor++;
    const slots = hooks.values;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
    return [slots[index], (value: unknown) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
  };
  return {
    ...react,
    useState: (initial: any) => (hooks.active ? state(initial) : react.useState(initial)),
    useEffect: (effect: any, deps?: any) => (hooks.active ? void hooks.effects.push(effect) : react.useEffect(effect, deps)),
  };
});
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
  hooks.effects = [];
  hooks.active = false;
  resetEditorSettingsForTests();
  resetTerminalSettingsForTests();
});

async function page() {
  const api = createMockApi({});
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return EditorPage({ api, onChanged: vi.fn() }); } finally { hooks.active = false; }
  };
  draw();
  hooks.effects.splice(0).forEach((e) => e());
  await tick();
  const all = () => nodes(draw());
  const field = (name: string) => all().find((n) => n.props["data-field"] === name)!;
  const sw = (name: string) => nodes(all().find((n) => n.props["data-switch"] === name)).find((n) => n.props.role === "switch")!;
  const font = () => all().find((n) => n.type === FontField)!;
  return { api, all, field, sw, font };
}

it("shows the stored values", async () => {
  const p = await page();
  expect(p.field("autosaveMs").props.value).toBe(String(EDITOR_DEFAULTS.autosaveMs));
  expect(p.field("fontSize").props.value).toBe("13");
  expect(p.sw("autosave").props["aria-checked"]).toBe(false);
});

it("toggling autosave stores it and updates the copy the open editors read", async () => {
  const p = await page();
  const put = vi.spyOn(p.api, "editorSettingsPut");
  p.sw("autosave").props.onClick();
  await tick();
  expect(put).toHaveBeenCalledWith({ ...EDITOR_DEFAULTS, autosave: true });
  expect(getEditorSettings().autosave).toBe(true);
  expect(p.sw("autosave").props["aria-checked"]).toBe(true);
});

it("a number clamps to its range before it is written", async () => {
  const p = await page();
  const put = vi.spyOn(p.api, "editorSettingsPut");
  p.field("autosaveMs").props.onChange({ target: { value: "5" } });
  p.field("autosaveMs").props.onBlur();
  await tick();
  expect(put).toHaveBeenCalledWith({ ...EDITOR_DEFAULTS, autosaveMs: 250 });
  p.field("fontSize").props.onChange({ target: { value: "99" } });
  p.field("fontSize").props.onKeyDown({ key: "Enter" });
  await tick();
  expect(getEditorSettings().fontSize).toBe(32);
});

it("a settings change reaches the shared copy the editors read", async () => {
  const api = createMockApi({});
  const stop = startEditorSettingsSync(api);
  await tick();
  await api.editorSettingsPut({ ...EDITOR_DEFAULTS, wordWrap: true });
  await tick();
  expect(getEditorSettings().wordWrap).toBe(true);
  stop();
});

it("renders the font family field with the terminal font as placeholder", async () => {
  let p = await page();
  expect(p.font().props.value).toBe("");
  expect(p.font().props.placeholder).toBe("var(--x-font-mono)");
  expect(p.font().props.labels).toEqual({ reset: "Use terminal font" });
  setTerminalSettings({ ...TERMINAL_DEFAULTS, fontFamily: " Menlo " });
  p = await page();
  expect(p.font().props.placeholder).toBe("Menlo");
});

it("saves a trimmed font family", async () => {
  const p = await page();
  const put = vi.spyOn(p.api, "editorSettingsPut");
  p.font().props.onChange("  Fira Code ");
  expect(put).not.toHaveBeenCalled();
  p.font().props.onKeyDown({ key: "Enter" });
  await tick();
  expect(put).toHaveBeenCalledWith({ ...EDITOR_DEFAULTS, fontFamily: "Fira Code" });
  expect(getEditorSettings().fontFamily).toBe("Fira Code");
});

it("clearing the font goes back to the terminal font at once", async () => {
  const p = await page();
  p.font().props.onChange("Fira Code");
  p.font().props.onBlur();
  await tick();
  const put = vi.spyOn(p.api, "editorSettingsPut");
  p.font().props.onChange("");
  await tick();
  expect(put).toHaveBeenCalledWith({ ...EDITOR_DEFAULTS, fontFamily: "" });
});
