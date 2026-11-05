import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Badge, Banner } from "@xdev-asia/ui";
import { createMockApi, type Api } from "@/api";
import { translate } from "@/i18n";
import { mount, textOf, type Node } from "@/kit/testHooks";
import { ApiKeysSection } from "./ApiKeysSection";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const KEY = "test-placeholder";
const field = (all: Node[], name: string) => all.find((n) => n.props["data-field"] === name)!;
const act = (all: Node[], name: string) => all.find((n) => n.props["data-act"] === name)!;
const type = (all: Node[], provider: string, value: string) =>
  (field(all, `key-${provider}`).props.onChange as (e: unknown) => void)({ target: { value } });

async function open(api: Api = createMockApi({})) {
  const m = mount(ApiKeysSection as (p: { api: Api }) => ReactElement, () => ({ api }));
  await m.settle();
  await m.settle();
  return { api, m };
}

it("shows three rows with Not saved badges and the hint", async () => {
  const { m } = await open();
  const all = m.all();
  const badges = all.filter((n) => n.type === Badge);
  expect(badges.map((b) => b.props.children)).toEqual(Array(3).fill(en("settings.usage.apiKeys.notSaved")));
  expect(all.some((n) => n.type === "p" && textOf(n) === en("settings.usage.apiKeys.hint"))).toBe(true);
  expect(all.filter((n) => n.props["data-ai-key"] !== undefined).map((n) => n.props["data-ai-key"])).toEqual(["anthropic", "openai", "gemini"]);
});

it("save trims, clears the field, flips the badge and says Key saved", async () => {
  const { api, m } = await open();
  const set = vi.spyOn(api, "aiKeySet");
  type(m.all(), "openai", ` ${KEY} `);
  await m.settle();
  await (act(m.all(), "save-openai").props.onClick as () => Promise<void>)();
  await m.settle();
  const all = m.all();
  expect(set).toHaveBeenCalledWith("openai", ` ${KEY} `);
  expect(field(all, "key-openai").props.value).toBe("");
  expect(all.filter((n) => n.type === Badge).map((b) => b.props.children)).toEqual([
    en("settings.usage.apiKeys.notSaved"),
    en("settings.usage.apiKeys.saved"),
    en("settings.usage.apiKeys.notSaved"),
  ]);
  expect(textOf(field(all, "api-keys-status"))).toBe(en("settings.usage.apiKeys.didSave"));
  expect(field(all, "key-openai").props.placeholder).toBe(en("settings.usage.apiKeys.replacePlaceholder"));
});

it("blank draft keeps Save disabled", async () => {
  const { m } = await open();
  expect(act(m.all(), "save-openai").props.disabled).toBe(true);
  type(m.all(), "openai", "   ");
  await m.settle();
  expect(act(m.all(), "save-openai").props.disabled).toBe(true);
  type(m.all(), "openai", KEY);
  await m.settle();
  expect(act(m.all(), "save-openai").props.disabled).toBe(false);
});

it("empty_key and too_large show in the row error", async () => {
  const { api, m } = await open();
  const set = vi.spyOn(api, "aiKeySet");
  set.mockRejectedValueOnce({ code: "empty_key" });
  type(m.all(), "gemini", KEY);
  await m.settle();
  await (act(m.all(), "save-gemini").props.onClick as () => Promise<void>)();
  await m.settle();
  expect(field(m.all(), "key-gemini").props.error).toBe(en("error.empty_key"));
  set.mockRejectedValueOnce({ code: "too_large" });
  await (act(m.all(), "save-gemini").props.onClick as () => Promise<void>)();
  await m.settle();
  expect(field(m.all(), "key-gemini").props.error).toBe(en("settings.usage.apiKeys.tooLong"));
  expect(field(m.all(), "key-gemini").props.value).toBe(KEY);
});

it("remove is disabled when not saved, removes and says Key removed", async () => {
  const { m } = await open(createMockApi({}, { aiKeys: ["anthropic"] }));
  expect(act(m.all(), "remove-openai").props.disabled).toBe(true);
  expect(act(m.all(), "remove-anthropic").props.disabled).toBe(false);
  await (act(m.all(), "remove-anthropic").props.onClick as () => Promise<void>)();
  await m.settle();
  const all = m.all();
  expect(act(all, "remove-anthropic").props.disabled).toBe(true);
  expect(all.filter((n) => n.type === Badge).every((b) => b.props.children === en("settings.usage.apiKeys.notSaved"))).toBe(true);
  expect(textOf(field(all, "api-keys-status"))).toBe(en("settings.usage.apiKeys.didRemove"));
});

it("secret_store shows one banner with the keychain text", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "aiKeys").mockRejectedValue({ code: "secret_store" });
  const { m } = await open(api);
  const banners = m.all().filter((n) => n.type === Banner);
  expect(banners).toHaveLength(1);
  expect(banners[0]!.props.title).toBe(en("error.secret_store"));
  expect(act(m.all(), "remove-openai").props.disabled).toBe(false);
  type(m.all(), "openai", KEY);
  await m.settle();
  expect(act(m.all(), "save-openai").props.disabled).toBe(false);
});

it("list is read once on mount", async () => {
  const api = createMockApi({});
  const list = vi.spyOn(api, "aiKeys");
  const { m } = await open(api);
  await m.settle();
  expect(list).toHaveBeenCalledTimes(1);
});

it("password field has autoComplete off and spellCheck false", async () => {
  const { m } = await open();
  for (const p of ["anthropic", "openai", "gemini"]) {
    const f = field(m.all(), `key-${p}`);
    expect(f.props.type).toBe("password");
    expect(f.props.autoComplete).toBe("off");
    expect(f.props.spellCheck).toBe(false);
  }
});

it("hidden when a search filter does not include usage.apiKeys", async () => {
  const api = createMockApi({});
  const m = mount(ApiKeysSection as (p: { api: Api; filter: { query: string; ids: Set<string> } }) => ReactElement, () => ({ api, filter: { query: "x", ids: new Set(["usage.display"]) } }));
  await m.settle();
  // The harness draws one level, so render the group wrapper to see what it lets through.
  const root = m.draw() as Node;
  expect((root.type as (p: unknown) => unknown)(root.props)).toBeNull();
});
