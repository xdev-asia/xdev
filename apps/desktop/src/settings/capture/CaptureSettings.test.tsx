import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { createMockApi, type Api } from "@/api";
import { Banner, Button, FieldMessage, Kbd, Switch } from "@xdev-asia/ui";
import { translate } from "@/i18n";
import { createMockCapture } from "@/mockCapture";
import { ShortcutRecorder } from "../shortcuts/ShortcutRecorder";
import { CAPTURE_COMMAND, CaptureSettings } from "./CaptureSettings";

const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
const copied = vi.hoisted(() => ({ texts: [] as string[] }));
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
    useCallback: (fn: any, deps: any) => (hooks.active ? fn : react.useCallback(fn, deps)),
  };
});
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));
vi.mock("@/ui/clipboard", () => ({ copyText: async (text: string) => (copied.texts.push(text), true) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const text = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" ? String(value) : Array.isArray(value) ? value.map(text).join("") : value && typeof value === "object" && "props" in value ? text((value as Node).props.children) : "";
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const en = (key: string) => translate("en", key);

beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
  hooks.effects = [];
  hooks.active = false;
  copied.texts = [];
});

async function page(api: Api = createMockApi({})) {
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return CaptureSettings({ api, onChanged: vi.fn() }); } finally { hooks.active = false; }
  };
  draw();
  hooks.effects.splice(0).forEach((e) => e());
  await tick();
  const all = () => nodes(draw());
  const row = (id: string) => nodes(all().find((n) => n.props["data-setting-id"] === id));
  const sw = (id: string) => row(id).find((n) => n.type === Switch)!;
  const banners = () => all().filter((n) => n.type === Banner);
  return { api, all, row, sw, banners };
}

it("the switches save and stay saved", async () => {
  const api = createMockApi({});
  const p = await page(api);
  expect(p.sw("capture.enabled").props.checked).toBe(true);
  expect(p.sw("capture.annotatePaste").props.checked).toBe(false);
  p.sw("capture.annotatePaste").props.onChange();
  await tick();
  expect(p.sw("capture.annotatePaste").props.checked).toBe(true);
  expect(await api.captureSettings()).toMatchObject({ enabled: true, annotatePaste: true });

  p.sw("capture.enabled").props.onChange();
  await tick();
  expect(await api.captureSettings()).toMatchObject({ enabled: false });
  expect(await api.captureShortcutApply()).toEqual({ status: "off" });
  expect(p.sw("capture.enabled").props.checked).toBe(false);
});

it("shows the shortcut and records a new one as an accelerator", async () => {
  const api = createMockApi({});
  const p = await page(api);
  expect(p.row("capture.shortcut").some((n) => n.type === Kbd)).toBe(true);
  const change = p.row("capture.shortcut").find((n) => n.type === Button)!;
  expect(text(change.props.children)).toBe(en("settings.capture.change"));
  change.props.onClick();
  const recorder = p.row("capture.shortcut").find((n) => n.type === ShortcutRecorder)!;
  expect(recorder).toBeDefined();
  recorder.props.onChord("Ctrl+Shift+F5");
  await tick();
  expect(p.row("capture.shortcut").some((n) => n.type === ShortcutRecorder)).toBe(false);
  expect((await api.captureSettings()).shortcut).toMatch(/^(CmdOrCtrl\+Shift\+F5|Ctrl\+Shift\+F5)$/);
});

it("a taken chord shows the message on the shortcut row", async () => {
  const api = { ...createMockApi({}), captureShortcutApply: async () => ({ status: "taken" as const, chord: "CmdOrCtrl+Alt+Shift+S" }) };
  const p = await page(api);
  const msg = p.row("capture.shortcut").find((n) => n.type === FieldMessage)!;
  expect(text(msg.props.children)).toBe(en("capture.err.shortcutTaken"));
  const change = p.row("capture.shortcut").find((n) => n.type === Button)!;
  expect(change.props["aria-describedby"]).toBe(msg.props.id);
});

it("on Wayland a banner offers the command to bind", async () => {
  const capture = createMockCapture({ mode: "wayland" });
  const p = await page({ ...createMockApi({}), ...capture });
  const [banner] = p.banners();
  expect(banner.props.title).toBe(en("capture.wayland.title"));
  expect(text(banner.props.children)).toContain(CAPTURE_COMMAND);
  const copy = banner.props.action as Node;
  expect(text(copy.props.children)).toBe(en("capture.wayland.copy"));
  copy.props.onClick();
  await tick();
  expect(copied.texts).toEqual([CAPTURE_COMMAND]);
  expect(text(p.banners()[0].props.children)).toContain(en("capture.wayland.copied"));
});

it("denied screen recording shows a banner that opens the privacy settings", async () => {
  const capture = createMockCapture({ mode: "denied" });
  const p = await page({ ...createMockApi({}), ...capture });
  const [banner] = p.banners();
  expect(banner.props.title).toBe(en("capture.perm.title"));
  (banner.props.action as Node).props.onClick();
  await tick();
  expect(capture.__capturePrivacyOpens()).toBe(1);
});

it("no banner when the shortcut is set and recording is allowed", async () => {
  const p = await page();
  expect(p.banners()).toEqual([]);
  expect(p.row("capture.shortcut").some((n) => n.type === FieldMessage)).toBe(false);
});
