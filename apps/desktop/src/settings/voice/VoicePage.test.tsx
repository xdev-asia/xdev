import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Dialog, Segmented, Select } from "@xdev-asia/ui";
import { createMockApi, type Api, type MicPermission } from "@/api";
import { translate } from "@/i18n";
import { mount, type Node } from "@/kit/testHooks";
import type { SettingsSectionProps } from "../sections";
import { OpenAiKeyDialog } from "./OpenAiKeyDialog";
import { VoicePage } from "./VoicePage";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const en = (key: string) => translate("en", key);
// The primary Button renders class "btn" (with a size class after it); the others are btn-<variant>.
const primaries = (html: string) => (html.match(/class="btn[" ]/g) ?? []).length;
const act = (all: Node[], name: string) => all.find((n) => n.props["data-act"] === name);

async function open(opts: { permission?: MicPermission; connected?: boolean } = {}) {
  const base = createMockApi({}, { aiKeys: opts.connected === false ? [] : ["openai"] });
  const api: Api = { ...base, speechPermission: async () => opts.permission ?? "denied" };
  const m = mount(VoicePage as (p: SettingsSectionProps) => ReactElement, () => ({ api, onChanged: vi.fn() }));
  await m.settle();
  await m.settle();
  return { api, m, html: () => renderToStaticMarkup(m.draw()) };
}

it("shows the mode, the microphones, a connected key and the privacy button, with no primary button", async () => {
  const { m, html } = await open();
  const all = m.all();
  const seg = all.find((n) => n.type === Segmented)!;
  expect(seg.props.options.map((o: { label: string }) => o.label)).toEqual([en("settings.voice.toggle"), en("settings.voice.hold")]);
  const mic = all.find((n) => n.type === Select && n.props["data-field"] === "mic")!;
  expect(mic.props.options.map((o: { label: string }) => o.label)).toEqual([en("settings.voice.micDefault"), "Built-in Microphone", "USB Headset"]);
  const markup = html();
  expect(markup).toContain(en("settings.voice.connected"));
  expect(markup).toContain(en("settings.voice.replace"));
  expect(markup).toContain(en("settings.voice.disconnect"));
  expect(markup).toContain(en("settings.voice.openPrivacy"));
  expect(markup).toContain("System default");
  expect(primaries(markup)).toBe(0);
});

it("notNeeded hides the permission row; notDetermined offers Allow microphone", async () => {
  const none = await open({ permission: "notNeeded" });
  expect(none.m.all().some((n) => n.props["data-setting-id"] === "voice.permission")).toBe(false);
  const ask = await open({ permission: "notDetermined" });
  const allow = act(ask.m.all(), "allow")!;
  expect(allow.props.children).toBe(en("settings.voice.allow"));
  allow.props.onClick();
  await ask.m.settle();
  expect(act(ask.m.all(), "allow")).toBeUndefined();
});

it("without a key: Not connected and Connect…, no Disconnect", async () => {
  const { m, html } = await open({ connected: false, permission: "granted" });
  expect(html()).toContain(en("settings.voice.notConnected"));
  expect(act(m.all(), "key")!.props.children).toBe(en("settings.voice.connect"));
  expect(act(m.all(), "disconnect")).toBeUndefined();
  act(m.all(), "key")!.props.onClick();
  expect(m.all().some((n) => n.type === OpenAiKeyDialog)).toBe(true);
});

it("the mode saves", async () => {
  const { api, m } = await open();
  m.all().find((n) => n.type === Segmented)!.props.onChange("hold");
  await m.settle();
  expect((await api.speechSettingsGet()).mode).toBe("hold");
  expect(m.all().find((n) => n.type === Segmented)!.props.value).toBe("hold");
});

it("Disconnect asks first, names Stats & Usage, and removes the openai key", async () => {
  const { api, m } = await open();
  const remove = vi.spyOn(api, "aiKeyRemove");
  act(m.all(), "disconnect")!.props.onClick();
  const alert = m.all().find((n) => n.type === Dialog)!;
  expect(alert.props.alert).toBe(true);
  expect(alert.props.children).toContain("Stats & Usage");
  alert.props.onConfirm();
  await m.settle();
  expect(remove).toHaveBeenCalledWith("openai");
  expect(m.all().some((n) => n.type === Dialog)).toBe(false);
  expect(act(m.all(), "disconnect")).toBeUndefined();
});
