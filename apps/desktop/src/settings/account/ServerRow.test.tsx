import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Banner, Button, FieldMessage } from "@xdev-asia/ui";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { ServerRow } from "./ServerRow";

const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const state = (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value; }];
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

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false; });

async function view(signedIn: boolean, prepare?: (api: ReturnType<typeof createMockApi>) => void) {
  const api = createMockApi({}, { xdevId: signedIn ? "signedIn" : "signedOut" });
  prepare?.(api);
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return ServerRow({ api, signedIn }); } finally { hooks.active = false; }
  };
  draw();
  hooks.effects.forEach((e) => e());
  await tick();
  const all = () => nodes(draw());
  const button = (label: string) => all().find((n) => n.type === Button && n.props.children === label);
  const labels = () => all().filter((n) => n.type === Button).map((n) => n.props.children);
  const banners = () => all().filter((n) => n.type === Banner).map((n) => n.props.title);
  const field = () => all().find((n) => n.props.label === en("account.server.label"))!;
  const submit = async () => { all().find((n) => n.type === "form")!.props.onSubmit({ preventDefault() {} }); await tick(); };
  return { api, all, button, labels, banners, field, submit };
}

it("the Server row shows the server in use, its source, an empty field and two secondary buttons", async () => {
  const v = await view(false);
  const texts = v.all().map((n) => n.props.children);
  expect(texts).toContain(translate("en", "account.server.current", { origin: "https://id.xdev.asia" }));
  expect(texts).toContain(en("account.server.source.default"));
  expect(v.field().props.value).toBe("");
  expect(v.labels()).toEqual([en("account.server.save"), en("account.server.useDefault")]);
  // The sign-in button is the page's one primary action, so neither of these is.
  expect(v.labels().every((l) => v.button(l as string)!.props.variant === "secondary")).toBe(true);
  expect(v.button(en("account.server.save"))!.props.type).toBe("submit");
  expect(v.button(en("account.server.useDefault"))!.props.type).toBe("button");
  expect(v.banners()).toEqual([]);
});

it("an invalid address shows the error and changes nothing", async () => {
  const v = await view(false);
  v.field().props.onChange({ target: { value: "http://id.corp.test" } });
  await v.submit();
  expect(v.all().find((n) => n.type === FieldMessage)!.props.children).toBe(en("error.account_server"));
  expect(v.all().map((n) => n.props.children)).toContain(translate("en", "account.server.current", { origin: "https://id.xdev.asia" }));
});

it("signed out: Save switches at once and Use default goes back", async () => {
  const v = await view(false);
  const spy = vi.spyOn(v.api, "xdevIdServerSet");
  v.field().props.onChange({ target: { value: " https://id.corp.test " } });
  await v.submit();
  expect(spy).toHaveBeenCalledWith("https://id.corp.test");
  const texts = () => v.all().map((n) => n.props.children);
  expect(texts()).toContain(translate("en", "account.server.current", { origin: "https://id.corp.test" }));
  expect(texts()).toContain(en("account.server.source.setting"));
  expect(v.field().props.value).toBe("https://id.corp.test");
  v.button(en("account.server.useDefault"))!.props.onClick();
  await tick();
  expect(spy).toHaveBeenLastCalledWith("");
  expect(texts()).toContain(en("account.server.source.default"));
});

it("signed in: a change asks first, and only the yes signs out and switches", async () => {
  const v = await view(true);
  const spy = vi.spyOn(v.api, "xdevIdServerSet");
  v.field().props.onChange({ target: { value: "https://id.corp.test" } });
  await v.submit();
  expect(spy).not.toHaveBeenCalled();
  expect(v.banners()).toEqual([en("account.server.confirm.title")]);
  expect(v.labels()).toEqual([en("account.server.confirm.yes"), en("account.server.confirm.no")]);
  v.button(en("account.server.confirm.no"))!.props.onClick();
  await tick();
  expect(spy).not.toHaveBeenCalled();
  expect(v.labels()).toEqual([en("account.server.save"), en("account.server.useDefault")]);
  await v.submit();
  v.button(en("account.server.confirm.yes"))!.props.onClick();
  await tick();
  expect(spy).toHaveBeenCalledWith("https://id.corp.test");
  expect(await v.api.xdevIdState()).toEqual({ state: "signedOut", notice: null });
  expect(v.banners()).toEqual([]);
});

it("an invalid setting found at startup shows a notice", async () => {
  const v = await view(false, (api) => {
    vi.spyOn(api, "xdevIdServer").mockResolvedValue({ origin: "https://id.xdev.asia", source: "default", setting: "nope", invalid: true });
  });
  expect(v.banners()).toEqual([en("account.server.invalid")]);
  expect(v.field().props.value).toBe("nope");
});

it("under XDEV_ID_URL the row says so and a save never asks to sign out", async () => {
  const v = await view(true, (api) => {
    vi.spyOn(api, "xdevIdServer").mockResolvedValue({ origin: "https://id.env.test", source: "env", setting: "", invalid: false });
  });
  expect(v.all().map((n) => n.props.children)).toContain(en("account.server.source.env"));
  const spy = vi.spyOn(v.api, "xdevIdServerSet").mockResolvedValue({ origin: "https://id.env.test", source: "env", setting: "https://id.corp.test", invalid: false });
  v.field().props.onChange({ target: { value: "https://id.corp.test" } });
  await v.submit();
  expect(spy).toHaveBeenCalledWith("https://id.corp.test");
  expect(v.banners()).toEqual([]);
});
