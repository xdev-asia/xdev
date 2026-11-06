import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Banner, Button, Dialog, Spinner } from "@xdev-asia/ui";
import { translate } from "@/i18n";
import { createMockLicense, type LicenseMockMode } from "@/mockLicense";
import { NoSeatDialog } from "@/license/NoSeatDialog";
import { LicensePanel } from "./LicensePanel";

const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0, effects: [] as (() => void | (() => void))[], deps: [] as unknown[][], at: 0 }));
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
    useEffect: (effect: any, deps?: any[]) => {
      if (!hooks.active) return react.useEffect(effect, deps);
      const i = hooks.at++;
      const before = hooks.deps[i];
      hooks.deps[i] = deps ?? [];
      if (!deps || !before || deps.some((d, k) => !Object.is(d, before[k]))) hooks.effects.push(effect);
    },
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

beforeEach(() => { hooks.values = []; hooks.deps = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false; });

async function view(mode: LicenseMockMode, now = 1793923200 * 1000) {
  const api = createMockLicense(mode);
  const draw = () => {
    hooks.cursor = 0;
    hooks.at = 0;
    hooks.effects = [];
    hooks.active = true;
    try { return LicensePanel({ api, signedIn: true, now }); } finally { hooks.active = false; }
  };
  // Draw, run that pass's effects, let the answers land; twice, so state set by effects is drawn.
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      draw();
      hooks.effects.forEach((e) => e());
      await tick();
    }
  };
  await settle();
  const all = () => nodes(draw());
  const buttons = () => all().filter((n) => n.type === Button);
  const button = (label: string) => buttons().find((n) => n.props.children === label)!;
  const texts = () => all().map((n) => n.props.children).filter((c) => typeof c === "string");
  return { api, settle, all, buttons, button, texts };
}

it("free: shows the Free plan and exactly one primary button, Get xDev Pro", async () => {
  const v = await view("free");
  expect(v.texts()).toContain(en("license.plan.free"));
  const primary = v.buttons().filter((b) => b.props.variant !== "secondary");
  expect(primary.map((b) => b.props.children)).toEqual([en("license.getPro")]);
  expect(v.buttons().every((b) => b.props.type === "button")).toBe(true);
});

it("Pro: shows the plan, updates date, seat count and one primary button, Refresh license", async () => {
  const v = await view("pro");
  expect(v.texts()).toContain(en("license.plan.pro"));
  expect(v.texts().some((t) => t.startsWith("Pro updates until"))).toBe(true);
  expect(v.texts()).toContain(en("license.devices", { used: 1, seats: 2 }));
  expect(v.buttons().filter((b) => b.props.variant !== "secondary").map((b) => b.props.children)).toEqual([en("license.refresh")]);
  expect(v.all().filter((n) => n.type === Banner)).toEqual([]);
});

it("Pro after the update window: says the updates ended", async () => {
  const v = await view("pro", 1900000000 * 1000);
  expect(v.texts().some((t) => t.startsWith("Pro updates ended on"))).toBe(true);
});

it("grace: a notice with the days offline", async () => {
  const v = await view("grace");
  expect(v.all().find((n) => n.type === Banner)!.props.title).toBe(en("license.notice.grace.title", { days: 9 }));
});

it("expired: an expired notice", async () => {
  const v = await view("expired");
  expect(v.all().find((n) => n.type === Banner)!.props.title).toBe(en("license.notice.expired.title"));
});

it("checkout: Get xDev Pro shows the waiting status and Stop waiting; completing it makes the plan Pro", async () => {
  const v = await view("free");
  v.button(en("license.getPro")).props.onClick();
  await v.settle();
  expect(v.all().some((n) => n.props.role === "status" && nodes(n.props.children).some((c) => c.type === Spinner))).toBe(true);
  expect(v.button(en("license.getPro")).props.disabled).toBe(true);
  expect(v.button(en("license.checkout.stop"))).toBeDefined();
  (v.api as any).__licenseCheckoutComplete();
  await v.settle();
  expect(v.texts()).toContain(en("license.plan.pro"));
  expect(v.texts()).toContain(en("license.devices", { used: 1, seats: 1 }));
  expect(v.buttons().some((b) => b.props.children === en("license.checkout.stop"))).toBe(false);
});

it("Stop waiting cancels the purchase without an error banner", async () => {
  const v = await view("free");
  v.button(en("license.getPro")).props.onClick();
  await v.settle();
  v.button(en("license.checkout.stop")).props.onClick();
  await v.settle();
  expect(v.all().filter((n) => n.type === Banner)).toEqual([]);
  expect(v.buttons().some((b) => b.props.children === en("license.checkout.stop"))).toBe(false);
});

it("no seat: Activate opens the no-seat dialog", async () => {
  const v = await view("noseat");
  v.button(en("license.activate")).props.onClick();
  await v.settle();
  expect(v.all().some((n) => n.type === NoSeatDialog)).toBe(true);
});

it("Deactivate asks first, then removes the device", async () => {
  const v = await view("pro");
  const spy = vi.spyOn(v.api, "licenseDeactivate");
  const named = v.buttons().find((b) => b.props["aria-label"] === en("license.deactivate.named", { name: "studio-mac" }))!;
  named.props.onClick();
  await v.settle();
  expect(spy).not.toHaveBeenCalled();
  const dialog = v.all().find((n) => n.type === Dialog)!;
  expect(dialog.props.alert).toBe(true);
  dialog.props.onConfirm();
  await v.settle();
  expect(spy).toHaveBeenCalledWith("dev-studio");
});
