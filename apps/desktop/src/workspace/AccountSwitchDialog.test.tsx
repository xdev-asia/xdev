import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { translate } from "@/i18n";
import en from "@/i18n/en.json";
import vi_ from "@/i18n/vi.json";
import { AccountSwitchDialog, type SwitchTab } from "./AccountSwitchDialog";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = typeof value === "function" ? (value as (v: unknown) => unknown)(hooks.values[index]) : value; }];
  },
  useRef: () => ({ current: null }),
  useEffect: () => {},
  useLayoutEffect: () => {},
  useId: () => "id",
}));
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

const tr = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const front: SwitchTab = { id: "a", label: "Fix the parser · xdev-oak", account: "claude-2", working: false };
function harness(over: Partial<Parameters<typeof AccountSwitchDialog>[0]> = {}) {
  const props = { provider: "claude" as const, to: "claude-3", tab: front, onApply: vi.fn(), onCancel: vi.fn(), ...over };
  const draw = () => { hooks.cursor = 0; return AccountSwitchDialog(props); };
  const group = () => nodes(draw()).find((n) => n.props.name === "account-switch-scope")!;
  return { props, draw, group, html: () => renderToStaticMarkup(draw()) };
}
beforeEach(() => { hooks.values = []; hooks.cursor = 0; });

it("is a modal dialog named for the account, with one apply and one cancel", () => {
  const dialog = harness().draw();
  expect(dialog.props.modal).toBe(true);
  expect(dialog.props.title).toBe(tr("accounts.switch.scope.title", { name: "claude-3" }));
  expect(dialog.props.confirmLabel).toBe(tr("accounts.switch.scope.apply"));
  expect(dialog.props.cancelLabel).toBe(tr("accounts.switch.scope.cancel"));
});

it("offers this tab, naming it and its account, or the default for new tabs", () => {
  const { options } = harness().group().props as { options: { value: string; label: string; hint: string }[] };
  expect(options.map((o) => o.value)).toEqual(["tab", "default"]);
  expect(options[0].hint).toBe(tr("accounts.switch.scope.tabHint", { tab: front.label, from: "claude-2" }));
  expect(options[1].hint).toBe(tr("accounts.switch.scope.defaultHint", { provider: tr("accounts.provider.claude") }));
});

it("warns that a working tab's turn stops, and names the CLI's own home", () => {
  const { options } = harness({ tab: { ...front, account: null, working: true } }).group().props as { options: { hint: string }[] };
  expect(options[0].hint).toBe(tr("accounts.switch.scope.tabHintWorking", { tab: front.label, from: tr("accounts.switch.cliDefaultName") }));
});

it("applies to this tab unless the default is picked", () => {
  const view = harness();
  expect(view.group().props.value).toBe("tab");
  view.draw().props.onConfirm();
  expect(view.props.onApply).toHaveBeenLastCalledWith("tab");
  view.group().props.onChange("default");
  expect(view.group().props.value).toBe("default");
  view.draw().props.onConfirm();
  expect(view.props.onApply).toHaveBeenLastCalledWith("default");
});

it("cancel changes nothing", () => {
  const view = harness();
  view.draw().props.onCancel();
  expect(view.props.onCancel).toHaveBeenCalledTimes(1);
  expect(view.props.onApply).not.toHaveBeenCalled();
});

it("uses theme tokens", () => {
  expect(harness().html()).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i);
});

it("has the dialog strings in both languages", () => {
  const keys = Object.keys(en).filter((k) => k.startsWith("accounts.switch.") || k.startsWith("accounts.alert.") || k.startsWith("accounts.restore."));
  expect(keys.length).toBeGreaterThan(15);
  for (const key of keys) expect(vi_).toHaveProperty(key);
});
