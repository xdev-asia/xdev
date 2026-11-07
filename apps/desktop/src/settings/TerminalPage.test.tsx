import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { getTerminalSettings, resetTerminalSettingsForTests, TERMINAL_DEFAULTS } from "@/terminal/terminalSettings";
import { RestoreSetting } from "./RestoreSetting";
import { runSearch } from "./searchModel";
import { SettingGroup, SettingRow } from "./SettingRow";
import { CLIPBOARD_SWITCHES, TerminalPage } from "./TerminalPage";
import { TerminalAppearanceSection } from "./terminal/TerminalAppearanceSection";
import { TerminalBehaviourSection } from "./terminal/TerminalBehaviourSection";
import { ANSI_KEYS, TerminalLookSection } from "./terminal/TerminalLookSection";
import { DEFAULT_WORD_SEPARATORS } from "./terminalDefaults";
import { TERMINAL_SCHEMES } from "@/terminal/terminalThemes";
import { getCustomSchemes, resetCustomSchemesForTests, setCustomSchemes } from "@/terminal/customSchemes";
import { ImportSchemeDialog } from "./terminal/ImportSchemeDialog";

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
    useSyncExternalStore: (sub: any, get: any, server?: any) => (hooks.active ? get() : react.useSyncExternalStore(sub, get, server)),
  };
});
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  // The two section files and the search wrappers are components; draw them where the page puts them.
  if (node.type === TerminalLookSection || node.type === TerminalAppearanceSection || node.type === TerminalBehaviourSection || node.type === SettingRow || node.type === SettingGroup) {
    return nodes((node.type as (p: unknown) => unknown)(node.props));
  }
  // A SettingRow draws its control from the `control` prop.
  return [node, ...nodes(node.props.children), ...nodes(node.props.control)];
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const en = (key: string) => translate("en", key);

beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
  hooks.effects = [];
  hooks.active = false;
  resetTerminalSettingsForTests();
  resetCustomSchemesForTests();
});

async function page(stored: Partial<typeof TERMINAL_DEFAULTS> = {}, filter?: Parameters<typeof TerminalPage>[0]["filter"]) {
  const api = createMockApi({});
  await api.terminalSettingsPut({ ...TERMINAL_DEFAULTS, ...stored });
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return TerminalPage({ api, onChanged: vi.fn(), filter }); } finally { hooks.active = false; }
  };
  draw();
  hooks.effects.splice(0).forEach((e) => e());
  await tick();
  // The sections hold hooks too, so they are drawn while the hook stand-ins are on.
  const all = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return nodes(TerminalPage({ api, onChanged: vi.fn(), filter })); } finally { hooks.active = false; }
  };
  const field = (name: string) => all().find((n) => n.props["data-field"] === name)!;
  const swRaw = (name: string) => nodes(all().find((n) => n.props["data-switch"] === name)).find((n) => n.props.role === "switch" || (n.props.checked !== undefined && n.props.onChange))!;
  const sw = (name: string) => {
    const n = swRaw(name);
    return n.props.role === "switch" ? n : { ...n, props: { ...n.props, "aria-checked": n.props.checked, onClick: n.props.onChange } };
  };
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

it("save output switch saves", async () => {
  const p = await page();
  const put = vi.spyOn(p.api, "terminalSettingsPut");
  expect(p.sw("saveScrollback").props["aria-checked"]).toBe(true);
  p.sw("saveScrollback").props.onClick();
  await tick();
  expect(put).toHaveBeenLastCalledWith({ ...TERMINAL_DEFAULTS, saveScrollback: false });
});

it("the service switch says it takes effect at the next start", async () => {
  const p = await page();
  const text = JSON.stringify(nodes(p.all().find((n) => n.props["data-switch"] === "service")).map((n) => n.props.children));
  expect(text).toContain(en("settings.terminal.service.hint"));
});

const gpuRadio = (p: Awaited<ReturnType<typeof page>>, m: string) => p.all().find((n) => n.props["data-gpu"] === m)!;
const bellRadio = (p: Awaited<ReturnType<typeof page>>, m: string) => p.all().find((n) => n.props["data-bell"] === m)!;

it("the theme select lists App and every scheme, and puts only the theme", async () => {
  const p = await page();
  const put = vi.spyOn(p.api, "terminalSettingsPut");
  const options = nodes(p.field("theme")).filter((n) => n.type === "option").map((n) => n.props.value);
  expect(options).toEqual(["app", ...TERMINAL_SCHEMES.map((s) => s.id)]);
  expect(p.field("theme").props.value).toBe("app");
  p.field("theme").props.onChange({ target: { value: "nord" } });
  await tick();
  expect(put).toHaveBeenCalledTimes(1);
  expect(put).toHaveBeenCalledWith({ ...TERMINAL_DEFAULTS, theme: "nord" });
  expect(getTerminalSettings().theme).toBe("nord");
});

it("the swatch strip follows the select", async () => {
  const p = await page();
  expect(p.all().filter((n) => n.props["data-swatch"])).toHaveLength(0);
  p.field("theme").props.onChange({ target: { value: "dracula" } });
  await tick();
  const swatches = p.all().filter((n) => n.props["data-swatch"]);
  expect(swatches.map((n) => n.props["data-swatch"])).toEqual([...ANSI_KEYS]);
  const dracula = TERMINAL_SCHEMES.find((s) => s.id === "dracula")!;
  expect(swatches.map((n) => n.props.style.background)).toEqual(ANSI_KEYS.map((k) => dracula.colors[k]));
  p.field("theme").props.onChange({ target: { value: "nord" } });
  await tick();
  const nord = TERMINAL_SCHEMES.find((s) => s.id === "nord")!;
  expect(p.all().filter((n) => n.props["data-swatch"]).map((n) => n.props.style.background)).toEqual(ANSI_KEYS.map((k) => nord.colors[k]));
});

it("an unknown stored theme shows as App", async () => {
  const p = await page({ theme: "gone" });
  expect(p.field("theme").props.value).toBe("app");
});

it("GPU radios put once with only the gpu, and show the hint", async () => {
  const p = await page();
  const put = vi.spyOn(p.api, "terminalSettingsPut");
  expect(gpuRadio(p, "auto").props.checked).toBe(true);
  gpuRadio(p, "off").props.onChange();
  await tick();
  expect(put).toHaveBeenCalledTimes(1);
  expect(put).toHaveBeenCalledWith({ ...TERMINAL_DEFAULTS, gpu: "off" });
  expect(gpuRadio(p, "off").props.checked).toBe(true);
  expect(JSON.stringify(p.all().map((n) => n.props.children))).toContain(en("settings.terminal.render.gpuHint"));
});

it("minimum contrast, scroll speed and fast scroll speed each put once, only their field, clamped", async () => {
  const p = await page();
  const put = vi.spyOn(p.api, "terminalSettingsPut");
  p.field("minimumContrast").props.onChange({ target: { value: "4.5" } });
  expect(put).not.toHaveBeenCalled();
  p.field("minimumContrast").props.onBlur();
  await tick();
  expect(put).toHaveBeenLastCalledWith({ ...TERMINAL_DEFAULTS, minimumContrast: 4.5 });
  p.field("scrollSensitivity").props.onChange({ target: { value: "9" } });
  p.field("scrollSensitivity").props.onKeyDown({ key: "Enter" });
  await tick();
  expect(put).toHaveBeenLastCalledWith({ ...TERMINAL_DEFAULTS, minimumContrast: 4.5, scrollSensitivity: 9 });
  expect(p.field("scrollSensitivity").props.value).toBe("3");
  p.field("fastScrollSensitivity").props.onChange({ target: { value: "7.5" } });
  p.field("fastScrollSensitivity").props.onBlur();
  await tick();
  expect(put).toHaveBeenCalledTimes(3);
  expect(put).toHaveBeenLastCalledWith({ ...TERMINAL_DEFAULTS, minimumContrast: 4.5, scrollSensitivity: 3, fastScrollSensitivity: 7.5 });
});

it("a number that is not a number, or did not change, writes nothing", async () => {
  const p = await page();
  const put = vi.spyOn(p.api, "terminalSettingsPut");
  p.field("minimumContrast").props.onChange({ target: { value: "" } });
  p.field("minimumContrast").props.onBlur();
  p.field("scrollSensitivity").props.onChange({ target: { value: "1.15" } });
  p.field("scrollSensitivity").props.onBlur();
  await tick();
  expect(put).not.toHaveBeenCalled();
  expect(p.field("minimumContrast").props.value).toBe("1");
});

it("focus follows mouse is a switch that puts only its field", async () => {
  const p = await page();
  const put = vi.spyOn(p.api, "terminalSettingsPut");
  expect(p.sw("focusFollowsMouse").props["aria-checked"]).toBe(false);
  p.sw("focusFollowsMouse").props.onClick();
  await tick();
  expect(put).toHaveBeenCalledTimes(1);
  expect(put).toHaveBeenCalledWith({ ...TERMINAL_DEFAULTS, focusFollowsMouse: true });
});

it("shell integration is on by default and its switch puts only its field", async () => {
  const p = await page();
  const put = vi.spyOn(p.api, "terminalSettingsPut");
  expect(p.sw("shellIntegration").props["aria-checked"]).toBe(true);
  p.sw("shellIntegration").props.onClick();
  await tick();
  expect(put).toHaveBeenCalledTimes(1);
  expect(put).toHaveBeenCalledWith({ ...TERMINAL_DEFAULTS, shellIntegration: false });
});

it("bell radios put once with only the bell; the hint points to Notifications", async () => {
  const p = await page();
  const put = vi.spyOn(p.api, "terminalSettingsPut");
  expect(bellRadio(p, "none").props.checked).toBe(true);
  bellRadio(p, "sound").props.onChange();
  await tick();
  expect(put).toHaveBeenCalledTimes(1);
  expect(put).toHaveBeenCalledWith({ ...TERMINAL_DEFAULTS, bell: "sound" });
  expect(JSON.stringify(p.all().map((n) => n.props.children))).toContain(en("settings.terminal.bell.hint"));
});

const linkRadio = (p: Awaited<ReturnType<typeof page>>, attr: "data-link-click" | "data-url-middle-click", m: string) => p.all().find((n) => n.props[attr] === m)!;

it("link radios put once with only their own field; the defaults are actions and open", async () => {
  const p = await page();
  const put = vi.spyOn(p.api, "terminalSettingsPut");
  expect(linkRadio(p, "data-link-click", "actions").props.checked).toBe(true);
  expect(linkRadio(p, "data-url-middle-click", "open").props.checked).toBe(true);
  linkRadio(p, "data-link-click", "none").props.onChange();
  await tick();
  expect(put).toHaveBeenCalledTimes(1);
  expect(put).toHaveBeenLastCalledWith({ ...TERMINAL_DEFAULTS, linkClick: "none" });
  linkRadio(p, "data-url-middle-click", "actions").props.onChange();
  await tick();
  expect(put).toHaveBeenCalledTimes(2);
  expect(put).toHaveBeenLastCalledWith({ ...TERMINAL_DEFAULTS, linkClick: "none", urlMiddleClick: "actions" });
  expect(JSON.stringify(p.all().map((n) => n.props.children))).toContain(en("settings.terminal.links.hint"));
});

it("word separators: committed on blur, Reset shown only when not default and puts the default", async () => {
  const p = await page();
  const put = vi.spyOn(p.api, "terminalSettingsPut");
  expect(p.all().some((n) => n.props["data-field"] === "words-reset")).toBe(false);
  p.field("wordSeparators").props.onChange({ target: { value: " /" } });
  expect(put).not.toHaveBeenCalled();
  p.field("wordSeparators").props.onBlur();
  await tick();
  expect(put).toHaveBeenCalledTimes(1);
  expect(put).toHaveBeenLastCalledWith({ ...TERMINAL_DEFAULTS, wordSeparators: " /" });
  const reset = p.all().find((n) => n.props["data-field"] === "words-reset")!;
  reset.props.onClick();
  await tick();
  expect(put).toHaveBeenCalledTimes(2);
  expect(put).toHaveBeenLastCalledWith({ ...TERMINAL_DEFAULTS, wordSeparators: DEFAULT_WORD_SEPARATORS });
  expect(p.all().some((n) => n.props["data-field"] === "words-reset")).toBe(false);
});

it("TUI scroll speed commits whole steps and clamps to 10", async () => {
  const p = await page();
  const put = vi.spyOn(p.api, "terminalSettingsPut");
  p.field("tuiScrollSensitivity").props.onChange({ target: { value: "4" } });
  p.field("tuiScrollSensitivity").props.onBlur();
  await tick();
  expect(put).toHaveBeenLastCalledWith({ ...TERMINAL_DEFAULTS, tuiScrollSensitivity: 4 });
  p.field("tuiScrollSensitivity").props.onChange({ target: { value: "99" } });
  p.field("tuiScrollSensitivity").props.onBlur();
  await tick();
  expect(put).toHaveBeenLastCalledWith({ ...TERMINAL_DEFAULTS, tuiScrollSensitivity: 99 });
  expect(p.field("tuiScrollSensitivity").props.value).toBe("10");
});

it("scroll Reset shows only off the defaults and puts all three scroll defaults at once", async () => {
  const p = await page();
  const put = vi.spyOn(p.api, "terminalSettingsPut");
  const reset = () => p.all().find((n) => n.props["data-field"] === "scroll-reset");
  expect(reset()).toBeUndefined();
  p.field("scrollSensitivity").props.onChange({ target: { value: "2" } });
  p.field("scrollSensitivity").props.onBlur();
  await tick();
  expect(put).toHaveBeenCalledTimes(1);
  reset()!.props.onClick();
  await tick();
  expect(put).toHaveBeenCalledTimes(2);
  expect(put).toHaveBeenLastCalledWith({
    ...TERMINAL_DEFAULTS,
    scrollSensitivity: TERMINAL_DEFAULTS.scrollSensitivity,
    fastScrollSensitivity: TERMINAL_DEFAULTS.fastScrollSensitivity,
    tuiScrollSensitivity: TERMINAL_DEFAULTS.tuiScrollSensitivity,
  });
  expect(reset()).toBeUndefined();
});

it("empty word separators put the default", async () => {
  const p = await page({ wordSeparators: " /" });
  const put = vi.spyOn(p.api, "terminalSettingsPut");
  p.field("wordSeparators").props.onChange({ target: { value: "" } });
  p.field("wordSeparators").props.onBlur();
  await tick();
  expect(put).toHaveBeenCalledTimes(1);
  expect(put).toHaveBeenCalledWith({ ...TERMINAL_DEFAULTS, wordSeparators: DEFAULT_WORD_SEPARATORS });
});

it("word separators without a space show a hint", async () => {
  const hint = (p: Awaited<ReturnType<typeof page>>) => p.all().some((n) => n.props["data-field"] === "words-hint");
  expect(hint(await page())).toBe(false);
  expect(hint(await page({ wordSeparators: "/." }))).toBe(true);
});

it("search shows only the matching row (webgl, chuông)", async () => {
  const t = (key: string) => en(key);
  const rows = async (query: string) => {
    const { ids } = runSearch(query, t, () => "Terminal");
    const p = await page({}, { query, ids });
    return p.all().map((n) => n.props["data-setting-id"]).filter(Boolean);
  };
  expect(await rows("webgl")).toEqual(["terminal.gpu"]);
  expect(await rows("chuông")).toEqual(["terminal.bell"]);
  expect(await rows("liên kết")).toEqual(["terminal.linkClick", "terminal.urlMiddleClick"]);
  expect(await rows("middle")).toEqual(["terminal.urlMiddleClick"]);
  expect(await rows("vim")).toEqual(["terminal.tuiScrollSensitivity"]);
});

const mine = { id: "custom-mine", name: "Mine", mode: "dark" as const, colors: TERMINAL_SCHEMES[0]!.colors };

it("lists imported schemes under Imported, selects one, and shows its swatches", async () => {
  setCustomSchemes([mine]);
  const p = await page({ theme: "custom-mine" });
  const group = nodes(p.field("theme")).find((n) => n.type === "optgroup")!;
  expect(group.props.label).toBe(en("settings.terminal.theme.imported"));
  expect(nodes(group).filter((n) => n.type === "option").map((n) => n.props.value)).toEqual(["custom-mine"]);
  expect(p.field("theme").props.value).toBe("custom-mine");
  expect(p.all().filter((n) => n.props["data-swatch"])).toHaveLength(16);
});

it("has no Imported group while nothing is imported", async () => {
  const p = await page();
  expect(nodes(p.field("theme")).some((n) => n.type === "optgroup")).toBe(false);
});

it("Remove trashes the scheme and the list reloads", async () => {
  const p = await page();
  const imported = await p.api.terminalThemeImport((await p.api.pickFile(["json"]))!, "fail");
  setCustomSchemes([imported]);
  const remove = vi.spyOn(p.api, "terminalThemeRemove");
  const btn = p.all().find((n) => n.props["data-remove"] === imported.id)!;
  btn.props.onClick();
  await tick();
  expect(remove).toHaveBeenCalledWith(imported.id);
  expect(getCustomSchemes()).toEqual([]);
});

it("removing the scheme the terminal uses puts the theme back to app", async () => {
  // The mock imports the demo file as this id.
  const p = await page({ theme: "custom-graphite-dark" });
  const imported = await p.api.terminalThemeImport((await p.api.pickFile(["json"]))!, "fail");
  expect(imported.id).toBe("custom-graphite-dark");
  const other = { ...imported, id: "custom-other", name: "Other" };
  setCustomSchemes([imported, other]);
  // Removing a scheme the terminal does not use leaves the theme alone.
  p.all().find((n) => n.props["data-remove"] === other.id)!.props.onClick();
  await tick();
  expect((await p.api.terminalSettings()).theme).toBe(imported.id);
  p.all().find((n) => n.props["data-remove"] === imported.id)!.props.onClick();
  await tick();
  expect((await p.api.terminalSettings()).theme).toBe("app");
});

it("Remove is enabled when nothing is busy", async () => {
  const p = await page();
  setCustomSchemes([mine]);
  expect(p.all().find((n) => n.props["data-remove"] === mine.id)!.props.disabled).toBe(false);
});

it("Import theme picks a file, previews it, and the dialog imports on the answer", async () => {
  const p = await page();
  const pick = vi.spyOn(p.api, "pickFile");
  const imp = vi.spyOn(p.api, "terminalThemeImport");
  expect(p.all().find((n) => n.type === ImportSchemeDialog)!.props.open).toBe(false);
  p.field("import").props.onClick();
  await tick();
  expect(pick).toHaveBeenCalledWith(["json", "yaml", "yml", "itermcolors"]);
  const dlg = () => p.all().find((n) => n.type === ImportSchemeDialog)!;
  expect(dlg().props.open).toBe(true);
  expect(dlg().props.preview.scheme.name).toBeTruthy();
  dlg().props.onImport("fail");
  await tick();
  expect(imp).toHaveBeenCalledWith(expect.any(String), "fail");
  expect(dlg().props.open).toBe(false);
  expect(getCustomSchemes()).toHaveLength(1);
});

it("a cancelled file dialog opens nothing, and a bad file shows its error", async () => {
  const p = await page();
  vi.spyOn(p.api, "pickFile").mockResolvedValueOnce(null);
  p.field("import").props.onClick();
  await tick();
  expect(p.all().find((n) => n.type === ImportSchemeDialog)!.props.open).toBe(false);
  vi.spyOn(p.api, "pickFile").mockResolvedValueOnce("/demo/themes/broken.json");
  p.field("import").props.onClick();
  await tick();
  const dlg = p.all().find((n) => n.type === ImportSchemeDialog)!;
  expect(dlg.props.open).toBe(true);
  expect(dlg.props.preview).toBeNull();
  expect(dlg.props.error).toEqual({ code: "theme_invalid", detail: "foreground" });
  dlg.props.onCancel();
  await tick();
  expect(p.all().find((n) => n.type === ImportSchemeDialog)!.props.open).toBe(false);
});

it("the appearance switches and numbers put only their own field", async () => {
  const p = await page();
  const put = vi.spyOn(p.api, "terminalSettingsPut");
  p.sw("dimInactivePanes").props.onClick();
  await tick();
  expect(put).toHaveBeenLastCalledWith({ ...TERMINAL_DEFAULTS, dimInactivePanes: true });
  p.sw("themeFollowApp").props.onClick();
  await tick();
  expect(put).toHaveBeenLastCalledWith({ ...TERMINAL_DEFAULTS, dimInactivePanes: true, themeFollowApp: true });
  p.field("paddingPx").props.onChange({ target: { value: "12" } });
  p.field("paddingPx").props.onKeyDown({ key: "Enter" });
  await tick();
  expect(put).toHaveBeenLastCalledWith({ ...TERMINAL_DEFAULTS, dimInactivePanes: true, themeFollowApp: true, paddingPx: 12 });
});
