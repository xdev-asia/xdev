import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Avatar, Banner, Button, FieldMessage } from "@xdev-asia/ui";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { AccountPage } from "./AccountPage";

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

async function view(xdevId?: "signedOut" | "signedIn", prepare?: (api: ReturnType<typeof createMockApi>) => void) {
  const api = createMockApi({}, { xdevId });
  prepare?.(api);
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return AccountPage({ api, onChanged() {} }); } finally { hooks.active = false; }
  };
  draw();
  hooks.effects.forEach((e) => e());
  await tick();
  const all = () => nodes(draw());
  const button = (label: string) => all().find((n) => n.type === Button && n.props.children === label);
  const labels = () => all().filter((n) => n.type === Button).map((n) => n.props.children);
  const banners = () => all().filter((n) => n.type === Banner).map((n) => n.props.title);
  return { api, all, button, labels, banners };
}

const LINK = "xdev://auth/callback?code=abc&state=demo";

it("signed out: one primary Sign in button and the about text", async () => {
  const v = await view();
  expect(v.labels()).toEqual([en("account.signIn")]);
  expect(v.button(en("account.signIn"))!.props.variant).toBe("primary");
  expect(v.all().some((n) => n.props.children === en("account.about"))).toBe(true);
  expect(v.banners()).toEqual([]);
});

it("Sign in calls xdevIdSignIn and shows the waiting controls", async () => {
  const v = await view();
  const spy = vi.spyOn(v.api, "xdevIdSignIn");
  v.button(en("account.signIn"))!.props.onClick();
  await tick();
  expect(spy).toHaveBeenCalledTimes(1);
  expect(v.labels()).toEqual([en("account.openAgain"), en("account.copyLink"), en("account.cancel"), en("account.paste.submit")]);
  // Only the submit inside the paste form is primary.
  expect(v.labels().filter((l) => v.button(l as string)!.props.variant !== "secondary")).toEqual([en("account.paste.submit")]);
  expect(v.button(en("account.paste.submit"))!.props.type).toBe("submit");
});

it("Cancel calls xdevIdCancel and returns to Sign in", async () => {
  const v = await view();
  v.button(en("account.signIn"))!.props.onClick();
  await tick();
  const spy = vi.spyOn(v.api, "xdevIdCancel");
  v.button(en("account.cancel"))!.props.onClick();
  await tick();
  expect(spy).toHaveBeenCalledTimes(1);
  expect(v.labels()).toEqual([en("account.signIn")]);
});

it("the paste form submits the field value and signs in", async () => {
  const v = await view();
  v.button(en("account.signIn"))!.props.onClick();
  await tick();
  const spy = vi.spyOn(v.api, "xdevIdPaste");
  const field = () => v.all().find((n) => n.props.label === en("account.paste.label"))!;
  field().props.onChange({ target: { value: LINK } });
  expect(field().props.value).toBe(LINK);
  const form = v.all().find((n) => n.type === "form")!;
  form.props.onSubmit({ preventDefault() {} });
  await tick();
  expect(spy).toHaveBeenCalledWith(LINK);
  expect(v.all().some((n) => n.type === Avatar)).toBe(true);
});

it("a paste rejection shows the error text and keeps the attempt", async () => {
  const v = await view();
  v.button(en("account.signIn"))!.props.onClick();
  await tick();
  v.all().find((n) => n.props.label === en("account.paste.label"))!.props.onChange({ target: { value: "nope" } });
  v.all().find((n) => n.type === "form")!.props.onSubmit({ preventDefault() {} });
  await tick();
  const msg = v.all().find((n) => n.type === FieldMessage)!;
  expect(msg.props.children).toBe(en("error.account_link"));
  expect(v.button(en("account.cancel"))).toBeDefined();
});

it("signed in: name, email, Avatar, Manage and Sign out and no primary button", async () => {
  const v = await view("signedIn");
  const texts = v.all().map((n) => n.props.children);
  expect(texts).toContain("Demo User");
  expect(texts).toContain("demo@example.com");
  const avatar = v.all().find((n) => n.type === Avatar)!;
  expect(avatar.props).toMatchObject({ name: "Demo User", src: null, size: "lg" });
  expect(v.labels()).toEqual([en("account.manage"), en("account.signOut")]);
  expect(v.labels().every((l) => v.button(l as string)!.props.variant === "secondary")).toBe(true);

  const manage = vi.spyOn(v.api, "xdevIdManage");
  v.button(en("account.manage"))!.props.onClick();
  expect(manage).toHaveBeenCalledTimes(1);
  const out = vi.spyOn(v.api, "xdevIdSignOut");
  v.button(en("account.signOut"))!.props.onClick();
  await tick();
  expect(out).toHaveBeenCalledTimes(1);
  expect(v.labels()).toEqual([en("account.signIn")]);
});

it("a notice renders as a banner and a changed event updates the view", async () => {
  const v = await view("signedIn");
  v.api.__xdevIdExpire();
  await tick();
  expect(v.banners()).toEqual([en("error.account_expired")]);
  expect(v.labels()).toEqual([en("account.signIn")]);
  await v.api.xdevIdSignIn();
  await tick();
  expect(v.banners()).toEqual([]);
  v.api.__xdevIdDeepLink();
  await tick();
  expect(v.labels()).toEqual([en("account.manage"), en("account.signOut")]);
});

it("a failed sign in shows its error code as a banner", async () => {
  const v = await view();
  vi.spyOn(v.api, "xdevIdSignIn").mockRejectedValue({ code: "account_keychain" });
  v.button(en("account.signIn"))!.props.onClick();
  await tick();
  expect(v.banners()).toEqual([en("error.account_keychain")]);
  expect(v.labels()).toEqual([en("account.signIn")]);
});

it("Open the page again reopens the running attempt and starts no new one", async () => {
  const v = await view();
  v.button(en("account.signIn"))!.props.onClick();
  await tick();
  const signIn = vi.spyOn(v.api, "xdevIdSignIn");
  const reopen = vi.spyOn(v.api, "xdevIdReopen");
  v.button(en("account.openAgain"))!.props.onClick();
  await tick();
  expect(reopen).toHaveBeenCalledTimes(1);
  expect(signIn).not.toHaveBeenCalled();
  expect(v.labels()).toContain(en("account.cancel"));

  vi.spyOn(v.api, "xdevIdReopen").mockRejectedValue({ code: "account_state" });
  v.button(en("account.openAgain"))!.props.onClick();
  await tick();
  expect(v.banners()).toEqual([en("error.account_state")]);
});

it("the state the first refresh returns is shown even when the first read said signed out", async () => {
  const v = await view("signedIn", (api) => {
    // Settings opened before the keychain loaded: the read is stale, the refresh is current.
    vi.spyOn(api, "xdevIdState").mockResolvedValue({ state: "signedOut", notice: null });
  });
  expect(v.labels()).toEqual([en("account.manage"), en("account.signOut")]);
});

it("Link copied clears when the attempt ends", async () => {
  const writes: string[] = [];
  vi.stubGlobal("navigator", { clipboard: { writeText: async (text: string) => void writes.push(text) } });
  try {
    const v = await view();
    v.button(en("account.signIn"))!.props.onClick();
    await tick();
    v.button(en("account.copyLink"))!.props.onClick();
    await tick();
    const copied = () => v.all().some((n) => n.props.children === en("account.copied"));
    expect(writes).toHaveLength(1);
    expect(copied()).toBe(true);
    v.button(en("account.cancel"))!.props.onClick();
    await tick();
    v.button(en("account.signIn"))!.props.onClick();
    await tick();
    expect(copied()).toBe(false);
  } finally {
    vi.unstubAllGlobals();
  }
});
