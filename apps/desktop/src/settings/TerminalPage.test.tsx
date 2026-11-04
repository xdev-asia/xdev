import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { getTerminalSettings, resetTerminalSettingsForTests, TERMINAL_DEFAULTS } from "@/terminal/terminalSettings";
import { RestoreSetting } from "./RestoreSetting";
import { CLIPBOARD_SWITCHES, TerminalPage } from "./TerminalPage";

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
const en = (key: string) => translate("en", key);

beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
  hooks.effects = [];
  hooks.active = false;
  resetTerminalSettingsForTests();
});

async function page(stored: Partial<typeof TERMINAL_DEFAULTS> = {}) {
  const api = createMockApi({});
  await api.terminalSettingsPut({ ...TERMINAL_DEFAULTS, ...stored });
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return TerminalPage({ api, onChanged: vi.fn() }); } finally { hooks.active = false; }
  };
  draw();
  hooks.effects.splice(0).forEach((e) => e());
  await tick();
  const all = () => nodes(draw());
  const field = (name: string) => all().find((n) => n.props["data-field"] === name)!;
  const sw = (name: string) => nodes(all().find((n) => n.props["data-switch"] === name)).find((n) => n.props.role === "switch")!;
  const button = (label: string) => all().find((n) => n.type === "button" && n.props.children === label)!;
  return { api, all, field, sw, button };
}

it("renders the stored values", async () => {
  const p = await page({ fontSize: 16, fontFamily: "Fira Code", cursorStyle: "bar", cursorBlink: false, scrollback: 500, osc52Clipboard: false });
  expect(p.field("fontSize").props.value).toBe("16");
  expect(p.field("fontFamily").props.value).toBe("Fira Code");
  expect(p.field("scrollback").props.value).toBe("500");
  expect(p.field("fontWeight").props.value).toBe("normal");
  expect(p.all().find((n) => n.props["data-cursor"] === "bar")!.props.checked).toBe(true);
  expect(p.all().find((n) => n.props["data-cursor"] === "block")!.props.checked).toBe(false);
  expect(p.sw("cursorBlink").props["aria-checked"]).toBe(false);
  expect(p.sw("osc52Clipboard").props["aria-checked"]).toBe(false);
  expect(CLIPBOARD_SWITCHES.map((k) => p.sw(k).props["aria-label"])).toEqual([
    en("settings.terminal.copyOnSelect"),
    en("settings.terminal.rightClickPaste"),
    en("settings.terminal.osc52Clipboard"),
  ]);
  expect(p.field("preview").props.style).toMatchObject({ fontFamily: "Fira Code", fontSize: 16 });
});

it("no longer holds the restore setting; General does", async () => {
  const p = await page();
  expect(p.all().some((n) => n.type === RestoreSetting)).toBe(false);
});

it("a toggle puts once with only the changed field and updates the shared copy", async () => {
  const p = await page({ copyOnSelect: true });
  const put = vi.spyOn(p.api, "terminalSettingsPut");
  p.sw("copyOnSelect").props.onClick();
  await tick();
  expect(put).toHaveBeenCalledTimes(1);
  expect(put).toHaveBeenCalledWith({ ...TERMINAL_DEFAULTS, copyOnSelect: false });
  expect(p.sw("copyOnSelect").props["aria-checked"]).toBe(false);
  expect(getTerminalSettings().copyOnSelect).toBe(false);
});

it("an out-of-range size is shown clamped after the put", async () => {
  const p = await page();
  const put = vi.spyOn(p.api, "terminalSettingsPut");
  p.field("fontSize").props.onChange({ target: { value: "200" } });
  expect(put).not.toHaveBeenCalled();
  expect(p.field("fontSize").props.value).toBe("200");
  p.field("fontSize").props.onBlur();
  await tick();
  expect(put).toHaveBeenCalledTimes(1);
  expect(p.field("fontSize").props.value).toBe("32");
  expect(getTerminalSettings().fontSize).toBe(32);
});

it("a size that is not a number writes nothing", async () => {
  const p = await page();
  const put = vi.spyOn(p.api, "terminalSettingsPut");
  p.field("fontSize").props.onChange({ target: { value: "" } });
  p.field("fontSize").props.onBlur();
  await tick();
  expect(put).not.toHaveBeenCalled();
  expect(p.field("fontSize").props.value).toBe("13");
});

it("picking a cursor style and a weight each put once", async () => {
  const p = await page();
  const put = vi.spyOn(p.api, "terminalSettingsPut");
  p.all().find((n) => n.props["data-cursor"] === "underline")!.props.onChange();
  await tick();
  expect(put).toHaveBeenLastCalledWith({ ...TERMINAL_DEFAULTS, cursorStyle: "underline" });
  p.field("fontWeight").props.onChange({ target: { value: "bold" } });
  await tick();
  expect(put).toHaveBeenCalledTimes(2);
  expect(put).toHaveBeenLastCalledWith({ ...TERMINAL_DEFAULTS, cursorStyle: "underline", fontWeight: "bold" });
});

it("reset puts the defaults", async () => {
  const p = await page({ fontSize: 20, scrollback: 5, cursorBlink: false });
  const put = vi.spyOn(p.api, "terminalSettingsPut");
  p.button(en("settings.terminal.reset")).props.onClick();
  await tick();
  expect(put).toHaveBeenCalledWith(TERMINAL_DEFAULTS);
  expect(p.field("fontSize").props.value).toBe("13");
  expect(getTerminalSettings()).toEqual(TERMINAL_DEFAULTS);
});

it("a failed write shows an error and keeps the shown values", async () => {
  const p = await page();
  vi.spyOn(p.api, "terminalSettingsPut").mockRejectedValueOnce({ code: "io" });
  p.sw("cursorBlink").props.onClick();
  await tick();
  expect(p.field("save-failed")).toBeDefined();
  expect(p.sw("cursorBlink").props["aria-checked"]).toBe(true);
});

it("the service rows: a switch, the On quit choice and the ring size, each one put", async () => {
  const p = await page();
  const put = vi.spyOn(p.api, "terminalSettingsPut");
  expect(p.sw("service").props["aria-checked"]).toBe(true);
  expect(p.field("onQuit").props.value).toBe("keep");
  expect(p.field("ringMb").props.value).toBe("2");
  p.sw("service").props.onClick();
  await tick();
  expect(put).toHaveBeenLastCalledWith({ ...TERMINAL_DEFAULTS, service: false });
  p.field("onQuit").props.onChange({ target: { value: "ask" } });
  await tick();
  expect(put).toHaveBeenLastCalledWith({ ...TERMINAL_DEFAULTS, service: false, onQuit: "ask" });
  p.field("ringMb").props.onChange({ target: { value: "99" } });
  p.field("ringMb").props.onBlur();
  await tick();
  expect(p.field("ringMb").props.value).toBe("16");
  expect(put).toHaveBeenCalledTimes(3);
});

it("the service switch says it takes effect at the next start", async () => {
  const p = await page();
  const text = JSON.stringify(nodes(p.all().find((n) => n.props["data-switch"] === "service")).map((n) => n.props.children));
  expect(text).toContain(en("settings.terminal.service.hint"));
});
