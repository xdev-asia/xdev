import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { getStatusSettings, resetStatusSettings } from "@/status/statusSettings";
import { CHANNELS, EVENTS, NotificationsPage } from "./NotificationsPage";

const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
const sound = vi.hoisted(() => ({ play: vi.fn(async () => true) }));
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
vi.mock("@/status/sound", async (original) => ({ ...await original<typeof import("@/status/sound")>(), playStatusSound: sound.play }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false; sound.play.mockClear(); });

async function page(withOnSaved = true) {
  const api = createMockApi({});
  const onSaved = vi.fn();
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return NotificationsPage({ api, onChanged: vi.fn(), onSaved: withOnSaved ? onSaved : undefined }); } finally { hooks.active = false; }
  };
  draw();
  hooks.effects.splice(0).forEach((e) => e());
  await tick();
  const all = () => nodes(draw());
  const sw = (channel: string) => nodes(all().find((n) => n.props["data-channel"] === channel)).find((n) => n.props.role === "switch")!;
  const button = (label: string) => all().find((n) => n.type === "button" && n.props.children === label)!;
  const master = () => nodes(all().find((n) => n.props["data-master"] === "enabled")).find((n) => n.props.role === "switch")!;
  const ev = (name: string) => nodes(all().find((n) => n.props["data-event"] === name)).find((n) => n.props.role === "switch")!;
  const volume = () => all().find((n) => n.props["data-field"] === "volume")!;
  const alert = () => all().find((n) => n.props.role === "alert");
  return { api, onSaved, all, sw, master, ev, button, volume, alert };
}

it("lists one switch per channel, all on by default", async () => {
  const p = await page();
  expect(CHANNELS).toEqual(["os", "sound", "bell", "badge"]);
  for (const c of CHANNELS) {
    expect(p.sw(c).props["aria-checked"]).toBe(true);
    expect(p.sw(c).props["aria-label"]).toBe(en(`settings.notifications.${c}`));
  }
});

it("toggling a channel saves it", async () => {
  for (const c of CHANNELS) {
    hooks.values = [];
    const p = await page();
    const put = vi.spyOn(p.api, "statusSettingsPut");
    p.sw(c).props.onClick();
    await tick();
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][0][c]).toBe(false);
    for (const other of CHANNELS.filter((o) => o !== c)) expect(put.mock.calls[0][0][other]).toBe(true);
    expect(p.sw(c).props["aria-checked"]).toBe(false);
    expect(p.onSaved).toHaveBeenCalledWith(expect.objectContaining({ [c]: false }));
  }
});

it("without onSaved a save updates the shared status settings", async () => {
  resetStatusSettings();
  const p = await page(false);
  p.sw("sound").props.onClick();
  await tick();
  expect(getStatusSettings().sound).toBe(false);
  resetStatusSettings();
});

it("volume is saved clamped when the slider is let go", async () => {
  const p = await page();
  const put = vi.spyOn(p.api, "statusSettingsPut");
  expect(p.volume().props.value).toBe(60);
  p.volume().props.onChange({ target: { value: "250" } });
  expect(put).not.toHaveBeenCalled();
  expect(p.volume().props.value).toBe(100);
  p.volume().props.onPointerUp();
  await tick();
  expect(put).toHaveBeenCalledWith(expect.objectContaining({ volume: 100 }));

  p.volume().props.onChange({ target: { value: "30" } });
  p.volume().props.onKeyUp();
  await tick();
  expect(put).toHaveBeenLastCalledWith(expect.objectContaining({ volume: 30 }));
  expect(p.volume().props.value).toBe(30);
  expect((await p.api.statusSettings()).volume).toBe(30);
});

it("letting go without a change saves nothing", async () => {
  const p = await page();
  const put = vi.spyOn(p.api, "statusSettingsPut");
  p.volume().props.onBlur();
  await tick();
  expect(put).not.toHaveBeenCalled();
});

it("a bad sound shows the error", async () => {
  const p = await page();
  vi.spyOn(p.api, "pickSoundFile").mockResolvedValue("C:/x/beep.exe");
  const set = vi.spyOn(p.api, "statusSoundSet");
  p.button(en("settings.notifications.pickSound")).props.onClick();
  await tick();
  expect(set).toHaveBeenCalledWith("C:/x/beep.exe");
  expect(p.alert()!.props.children).toBe(en("error.bad_sound"));
});

it("own sound is used, then the default beep again", async () => {
  const p = await page();
  vi.spyOn(p.api, "pickSoundFile").mockResolvedValue("C:/x/ding.ogg");
  const set = vi.spyOn(p.api, "statusSoundSet");
  const file = () => p.all().find((n) => n.props["data-field"] === "sound-file")!.props.children;
  expect(file()).toBe(en("settings.notifications.soundBeep"));
  expect(p.button(en("settings.notifications.useBeep")).props.disabled).toBe(true);
  p.button(en("settings.notifications.pickSound")).props.onClick();
  await tick();
  expect(file()).toBe(en("settings.notifications.soundOwn", { name: "custom.ogg" }));
  expect(p.alert()).toBeUndefined();

  p.button(en("settings.notifications.useBeep")).props.onClick();
  await tick();
  expect(set).toHaveBeenLastCalledWith(null);
  expect(file()).toBe(en("settings.notifications.soundBeep"));
});

it("a cancelled pick changes nothing", async () => {
  const p = await page();
  const set = vi.spyOn(p.api, "statusSoundSet");
  p.button(en("settings.notifications.pickSound")).props.onClick();
  await tick();
  expect(set).not.toHaveBeenCalled();
});

it("the master switch and each event switch save, bell off by default", async () => {
  expect(EVENTS).toEqual(["onNeedsInput", "onDone", "onFailed", "onBell"]);
  const p = await page();
  expect(p.master().props["aria-checked"]).toBe(true);
  expect(p.ev("onNeedsInput").props["aria-checked"]).toBe(true);
  expect(p.ev("onBell").props["aria-checked"]).toBe(false);
  const put = vi.spyOn(p.api, "statusSettingsPut");
  p.ev("onBell").props.onClick();
  await tick();
  expect(put.mock.calls[0][0].onBell).toBe(true);
  expect(p.ev("onBell").props["aria-checked"]).toBe(true);
  p.ev("onDone").props.onClick();
  await tick();
  expect(put.mock.calls[1][0]).toEqual(expect.objectContaining({ onDone: false, onBell: true }));
  p.master().props.onClick();
  await tick();
  expect(put.mock.calls[2][0].enabled).toBe(false);
  // Under an off master switch the event switches cannot be flipped.
  for (const e of EVENTS) expect(p.ev(e).props.disabled).toBe(true);
  expect(translate("vi", "settings.notifications.onBell")).toBe("Chuông terminal");
});

it("test sends a real OS notification and plays the sound even when sound is off", async () => {
  const p = await page();
  const notify = vi.spyOn(p.api, "statusNotify");
  p.sw("sound").props.onClick();
  await tick();
  p.volume().props.onChange({ target: { value: "20" } });
  p.button(en("settings.notifications.test")).props.onClick();
  await tick();
  expect(notify).toHaveBeenCalledWith(en("settings.notifications.testTitle"), en("settings.notifications.testBody"), "");
  expect(sound.play).toHaveBeenCalledTimes(1);
  const [api, settings, now, force] = sound.play.mock.calls[0] as unknown as [unknown, { sound: boolean; volume: number }, number, boolean];
  expect(api).toBe(p.api);
  expect(settings).toEqual(expect.objectContaining({ sound: false, volume: 20 }));
  expect(typeof now).toBe("number");
  expect(force).toBe(true);
  expect(p.all().some((n) => n.props["data-field"] === "test-failed")).toBe(false);
});

it("a test the OS refuses shows a hint", async () => {
  const p = await page();
  vi.spyOn(p.api, "statusNotify").mockRejectedValue({ code: "io" });
  p.button(en("settings.notifications.test")).props.onClick();
  await tick();
  expect(p.all().find((n) => n.props["data-field"] === "test-failed")!.props.children).toBe(en("settings.notifications.testFailed"));
});

it("a failed load shows the error", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "statusSettings").mockRejectedValue({ code: "io", detail: "x" });
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return nodes(NotificationsPage({ api, onChanged: vi.fn() })); } finally { hooks.active = false; }
  };
  draw();
  hooks.effects.splice(0).forEach((e) => e());
  await tick();
  expect(draw().find((n) => n.props.role === "alert")!.props.children).toBe(en("error.io"));
});

it("the suppress-when-focused switch is on by default and saves when toggled", async () => {
  const p = await page();
  const put = vi.spyOn(p.api, "statusSettingsPut");
  const sup = () => nodes(p.all().find((n) => n.props["data-option"] === "suppressWhenFocused")).find((n) => n.props.role === "switch")!;
  expect(sup().props["aria-checked"]).toBe(true);
  expect(sup().props["aria-label"]).toBe(en("settings.notifications.suppressWhenFocused"));
  sup().props.onClick();
  await tick();
  expect(put).toHaveBeenCalledWith(expect.objectContaining({ suppressWhenFocused: false }));
  expect(sup().props["aria-checked"]).toBe(false);
  expect(p.onSaved).toHaveBeenCalledWith(expect.objectContaining({ suppressWhenFocused: false }));
});
