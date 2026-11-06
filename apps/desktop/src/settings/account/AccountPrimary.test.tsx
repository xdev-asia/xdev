import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Button } from "@xdev-asia/ui";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { LicensePanel } from "../license/LicensePanel";
import { AccountPage } from "./AccountPage";

const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0, effects: [] as (() => void | (() => void))[] }));
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

it("signed out: the Account page has exactly one primary button, Sign in; Get xDev Pro is secondary", async () => {
  const api = createMockApi({}, { xdevId: "signedOut" });
  const draw = <T,>(render: () => T): T => {
    hooks.cursor = 0;
    hooks.effects = [];
    hooks.active = true;
    try { return render(); } finally { hooks.active = false; }
  };
  const page = draw(() => AccountPage({ api, onChanged() {} }));
  hooks.effects.forEach((e) => e());
  await tick();
  const tree = nodes(draw(() => AccountPage({ api, onChanged() {} })));
  const panel = tree.find((n) => n.type === LicensePanel)!;
  expect(panel.props.signedIn).toBe(false);
  // The panel is its own component: draw it with the same hooks, after its reads land.
  hooks.values = [];
  draw(() => LicensePanel(panel.props as Parameters<typeof LicensePanel>[0]));
  hooks.effects.forEach((e) => e());
  await tick();
  const inPanel = nodes(draw(() => LicensePanel(panel.props as Parameters<typeof LicensePanel>[0])));
  void page;
  const buttons = [...tree, ...inPanel].filter((n) => n.type === Button);
  const primary = buttons.filter((b) => b.props.variant !== "secondary").map((b) => b.props.children);
  expect(primary).toEqual([en("account.signIn")]);
  expect(buttons.find((b) => b.props.children === en("license.getPro"))!.props.variant).toBe("secondary");
});
