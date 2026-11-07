import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Banner, Button, Field } from "@xdev-asia/ui";
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
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false; });

async function view(prepare?: (api: ReturnType<typeof createMockApi>) => void, openSection?: (id: string) => void) {
  const api = createMockApi({}, { xdevId: "signedOut" });
  prepare?.(api);
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return ServerRow({ api, openSection }); } finally { hooks.active = false; }
  };
  draw();
  hooks.effects.forEach((e) => e());
  await tick();
  const all = () => nodes(draw());
  const texts = () => all().map((n) => n.props.children);
  const buttons = () => all().filter((n) => n.type === Button);
  const banners = () => all().filter((n) => n.type === Banner).map((n) => n.props.title);
  return { api, all, texts, buttons, banners };
}

it("one setting: both places call it the xDev server", () => {
  expect(en("account.server.title")).toBe("xDev server");
  expect(en("cloud.server.title")).toBe("xDev server");
  expect(translate("vi", "account.server.title")).toBe(translate("vi", "cloud.server.title"));
});

it("the row only shows the server in use and where it comes from; it has no field of its own", async () => {
  const v = await view();
  expect(v.texts()).toContain(en("account.server.title"));
  expect(v.texts()).toContain(en("account.server.current", { origin: "https://id.xdev.asia" }));
  expect(v.texts()).toContain(en("account.server.source.default"));
  expect(v.texts()).toContain(en("account.server.hint"));
  expect(v.all().some((n) => n.type === Field || n.type === "form" || n.type === "input")).toBe(false);
  expect(v.banners()).toEqual([]);
  // Without a way to switch sections there is nothing to press.
  expect(v.buttons()).toEqual([]);
});

it("Change opens Settings → Cloud, the one place that edits it", async () => {
  const openSection = vi.fn();
  const v = await view(undefined, openSection);
  const change = v.buttons();
  expect(change.map((b) => b.props.children)).toEqual([en("account.server.change")]);
  // The sign-in button is the page's one primary action.
  expect(change[0]!.props.variant).toBe("secondary");
  expect(change[0]!.props.type).toBe("button");
  change[0]!.props.onClick();
  expect(openSection).toHaveBeenCalledWith("cloud");
});

it("a server saved in Settings → Cloud shows here as the setting", async () => {
  const v = await view((api) => {
    vi.spyOn(api, "xdevIdServer").mockResolvedValue({ origin: "https://id.corp.test", source: "setting", setting: "https://id.corp.test", invalid: false });
  });
  expect(v.texts()).toContain(en("account.server.current", { origin: "https://id.corp.test" }));
  expect(v.texts()).toContain(en("account.server.source.setting"));
});

it("an invalid setting found at startup shows a notice", async () => {
  const v = await view((api) => {
    vi.spyOn(api, "xdevIdServer").mockResolvedValue({ origin: "https://id.xdev.asia", source: "default", setting: "nope", invalid: true });
  });
  expect(v.banners()).toEqual([en("account.server.invalid")]);
});

it("under XDEV_ID_URL the row says so", async () => {
  const v = await view((api) => {
    vi.spyOn(api, "xdevIdServer").mockResolvedValue({ origin: "https://id.env.test", source: "env", setting: "", invalid: false });
  });
  expect(v.texts()).toContain(en("account.server.source.env"));
});

it("the api has no second way to save the server", () => {
  expect("xdevIdServerSet" in createMockApi({}, {})).toBe(false);
});
