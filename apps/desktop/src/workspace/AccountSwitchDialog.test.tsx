import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { translate } from "@/i18n";
import en from "@/i18n/en.json";
import vi_ from "@/i18n/vi.json";
import { AccountSwitchDialog, type SwitchRow } from "./AccountSwitchDialog";

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
const rows: SwitchRow[] = [
  { id: "a", label: "Fix the parser · xdev-oak", working: false },
  { id: "b", label: "Write tests · xdev-oak", working: true },
  { id: "c", label: "claude · xdev-elm", working: false },
];
function harness(over: Partial<Parameters<typeof AccountSwitchDialog>[0]> = {}) {
  const props = { provider: "claude" as const, from: "claude-2", to: "claude-3", rows, onRestart: vi.fn(), onKeep: vi.fn(), ...over };
  const draw = () => { hooks.cursor = 0; return AccountSwitchDialog(props); };
  const find = (action: string) => nodes(draw()).find((n) => n.props["data-action"] === action)!;
  return { props, draw, html: () => renderToStaticMarkup(draw()), find };
}
beforeEach(() => { hooks.values = []; hooks.cursor = 0; });

it("names the switch and lists every tab, a working one marked", () => {
  const html = harness().html();
  expect(html).toContain(tr("accounts.switch.dialog.title"));
  expect(html).toContain(tr("accounts.switch.dialog.body", { provider: tr("accounts.provider.claude"), from: "claude-2", to: "claude-3" }));
  for (const r of rows) expect(html).toContain(r.label);
  expect(html.match(new RegExp(tr("accounts.switch.dialog.working").replace(/[()]/g, "\\$&"), "g"))).toHaveLength(1);
});
it("names the CLI default when there is no account", () => {
  const html = harness({ from: null, to: null }).html();
  expect(html).toContain(tr("accounts.switch.cliDefaultName"));
});
it("ticks every tab except the working ones", () => {
  const view = harness();
  expect(view.find("switch-tab-a").props.checked).toBe(true);
  expect(view.find("switch-tab-b").props.checked).toBe(false);
  expect(view.find("switch-tab-c").props.checked).toBe(true);
});
it("Restart selected sends the ticked ids, with the remember box", () => {
  const view = harness();
  view.find("switch-tab-b").props.onChange({ target: { checked: true } });
  view.find("switch-tab-a").props.onChange({ target: { checked: false } });
  view.find("switch-restart").props.onClick();
  expect(view.props.onRestart).toHaveBeenCalledWith(["b", "c"], false);
  view.find("switch-remember").props.onChange({ target: { checked: true } });
  view.find("switch-restart").props.onClick();
  expect(view.props.onRestart).toHaveBeenLastCalledWith(["b", "c"], true);
});
it("Restart selected is disabled with nothing ticked", () => {
  const view = harness({ rows: [rows[1]] });
  expect(view.find("switch-restart").props.disabled).toBe(true);
});
it("Keep all, and Escape, keep the tabs; only Keep all can be remembered", () => {
  const view = harness();
  view.find("switch-remember").props.onChange({ target: { checked: true } });
  view.find("switch-keep").props.onClick();
  expect(view.props.onKeep).toHaveBeenCalledWith(true);
  const dialog = view.draw();
  const prevent = vi.fn();
  dialog.props.onCancel({ preventDefault: prevent });
  expect(prevent).toHaveBeenCalled();
  expect(view.props.onKeep).toHaveBeenLastCalledWith(false);
});
it("uses theme tokens and plain controls", () => {
  const html = harness().html();
  expect(html).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i);
  expect(html.match(/type="checkbox"/g)).toHaveLength(rows.length + 1);
});
it("has the dialog strings in both languages", () => {
  const keys = Object.keys(en).filter((k) => k.startsWith("accounts.switch."));
  expect(keys.length).toBeGreaterThan(10);
  for (const key of keys) expect(vi_).toHaveProperty(key);
});
