import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Button, Dialog } from "@xdev-asia/ui";
import { translate } from "@/i18n";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const i = hooks.cursor++;
      if (!(i in hooks.values)) hooks.values[i] = initial;
      return [hooks.values[i], (v: unknown) => { hooks.values[i] = v; }];
    },
    useRef: (initial: unknown) => {
      const i = hooks.cursor++;
      if (!(i in hooks.values)) hooks.values[i] = { current: initial };
      return hooks.values[i];
    },
    useEffect: () => undefined,
  };
});
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

import { Upsell, featureLabelKey } from "./Upsell";

type Node = ReactElement<Record<string, any>>;
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function setup(buy: () => Promise<void> = () => Promise.resolve()) {
  const api = { licenseBuy: vi.fn(buy), licenseBuyCancel: vi.fn(() => Promise.resolve()), openUrl: vi.fn(() => Promise.resolve()) };
  const onClose = vi.fn();
  const draw = () => {
    hooks.cursor = 0;
    return Upsell({ api: api as never, feature: "pro.early", onClose }) as Node;
  };
  return { api, onClose, draw };
}
const flat = (n: unknown): Node[] => (Array.isArray(n) ? n.flatMap(flat) : n && typeof n === "object" && "props" in n ? [n as Node, ...flat((n as Node).props.children)] : []);

beforeEach(() => { hooks.values = []; hooks.cursor = 0; });

it("names the feature in the title and has Get xDev Pro as its only primary action", () => {
  const out = setup().draw();
  expect(out.type).toBe(Dialog);
  expect(out.props.title).toBe("Early builds is part of xDev Pro");
  expect(out.props.confirmLabel).toBe(en("license.getPro"));
  expect(featureLabelKey("pro.usage_history")).toBe("pro.feature.usage_history");
  const buttons = flat(out.props.children).filter((n) => n.type === Button);
  expect(buttons.map((b) => b.props.children)).toEqual([en("pro.upsell.learn")]);
  expect(buttons.every((b) => b.props.variant === "secondary" && b.props.type === "button")).toBe(true);
});

it("Get xDev Pro starts the purchase of pro and closes when it lands", async () => {
  const s = setup();
  s.draw().props.onConfirm();
  expect(s.api.licenseBuy).toHaveBeenCalledWith("pro");
  await tick();
  expect(s.onClose).toHaveBeenCalledTimes(1);
});

it("Learn more goes through the opener", () => {
  const s = setup();
  const learn = flat(s.draw().props.children).find((n) => n.type === Button)!;
  learn.props.onClick();
  expect(s.api.openUrl).toHaveBeenCalledTimes(1);
});

it("a cancelled purchase shows no error; another failure shows its message", async () => {
  const cancelled = setup(() => Promise.reject({ code: "cancelled" }));
  cancelled.draw().props.onConfirm();
  await tick();
  expect(flat(cancelled.draw().props.children).some((n) => n.props.role === "alert")).toBe(false);
  hooks.values = [];
  const failed = setup(() => Promise.reject({ code: "license_unavailable" }));
  failed.draw().props.onConfirm();
  await tick();
  const alert = flat(failed.draw().props.children).find((n) => n.props.role === "alert")!;
  expect(alert.props.children).toBe(en("error.license_unavailable"));
});

it("closing while waiting stops the checkout", () => {
  const s = setup(() => new Promise(() => undefined));
  s.draw().props.onConfirm();
  s.draw().props.onCancel();
  expect(s.api.licenseBuyCancel).toHaveBeenCalledTimes(1);
  expect(s.onClose).toHaveBeenCalledTimes(1);
});
