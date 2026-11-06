import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Dialog, Field } from "@xdev-asia/ui";
import { translate } from "@/i18n";
import { mount } from "@/kit/testHooks";
import { OpenAiKeyDialog } from "./OpenAiKeyDialog";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

type Props = Parameters<typeof OpenAiKeyDialog>[0];
const KEY = "test-placeholder";

function open() {
  const aiKeySet = vi.fn(async () => {});
  const onSaved = vi.fn();
  const m = mount(OpenAiKeyDialog as (p: Props) => ReactElement, () => ({ api: { aiKeySet }, onSaved, onCancel: vi.fn() }));
  const dialog = () => m.all().find((n) => n.type === Dialog)!;
  const field = () => m.all().find((n) => n.type === Field)!;
  const type = (value: string) => field().props.onChange({ target: { value } });
  return { m, aiKeySet, onSaved, dialog, field, type };
}

it("confirm stays disabled while the field is empty or blank", () => {
  const d = open();
  expect(d.dialog().props.confirmDisabled).toBe(true);
  d.type("   ");
  expect(d.dialog().props.confirmDisabled).toBe(true);
  d.type(KEY);
  expect(d.dialog().props.confirmDisabled).toBe(false);
});

it("save sends the trimmed key once, then clears the field", async () => {
  const d = open();
  d.type(`  ${KEY} `);
  d.dialog().props.onConfirm();
  await d.m.settle();
  expect(d.aiKeySet).toHaveBeenCalledTimes(1);
  expect(d.aiKeySet).toHaveBeenCalledWith("openai", KEY);
  expect(d.field().props.value).toBe("");
  expect(d.onSaved).toHaveBeenCalledTimes(1);
});

it("markup: one primary button and a password input without autocomplete", () => {
  const d = open();
  const html = renderToStaticMarkup(d.m.draw());
  // The primary Button renders class "btn"; the others are btn-<variant>.
  expect((html.match(/class="btn[" ]/g) ?? []).length).toBe(1);
  expect(html).toMatch(/<input[^>]*type="password"/);
  expect(html).toMatch(/<input[^>]*autoComplete="off"|<input[^>]*autocomplete="off"/);
  expect(html).toContain(translate("en", "settings.voice.keySave"));
});
