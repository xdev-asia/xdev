import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Button, Dialog, Field } from "@xdev-asia/ui";
import { translate } from "@/i18n";
import { createMockCloud } from "@/mockCloud";
import { ServerPanel } from "./ServerPanel";

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

const KEY = "A".repeat(43);

async function view(onServerChange = vi.fn()) {
  const api = createMockCloud(onServerChange);
  const draw = () => {
    hooks.cursor = 0;
    hooks.at = 0;
    hooks.effects = [];
    hooks.active = true;
    try { return ServerPanel({ api }); } finally { hooks.active = false; }
  };
  const settle = async () => {
    for (let i = 0; i < 3; i++) { draw(); hooks.effects.forEach((e) => e()); await tick(); }
  };
  await settle();
  const all = () => nodes(draw());
  const fields = () => all().filter((n) => n.type === Field);
  const button = (label: string) => all().find((n) => n.type === Button && n.props.children === label)!;
  const submit = async () => { all().find((n) => n.type === "form")!.props.onSubmit({ preventDefault() {} }); await tick(); await settle(); };
  const type = async (field: Node, value: string) => { field.props.onChange({ target: { value } }); await settle(); };
  return { api, onServerChange, settle, all, fields, button, submit, type };
}

it("starts on the official service: an empty server field, Save disabled, no confirm dialog", async () => {
  const v = await view();
  expect(v.fields()[0]!.props.value).toBe("");
  expect(v.button(en("cloud.save")).props.disabled).toBe(true);
  expect(v.all().some((n) => n.type === Dialog)).toBe(false);
});

it("a custom server without a key shows the need-key alert and cannot be saved", async () => {
  const v = await view();
  await v.type(v.fields()[0]!, "https://license.example.com");
  expect(v.all().find((n) => n.props.role === "alert")!.props.children).toBe(en("cloud.err.needRoot"));
  expect(v.button(en("cloud.save")).props.disabled).toBe(true);
});

it("a key shows its fingerprint, and a bad key shows an error", async () => {
  const v = await view();
  await v.type(v.fields()[0]!, "https://license.example.com");
  await v.type(v.fields()[1]!, KEY);
  expect(v.fields()[1]!.props.hint).toBe(en("cloud.root.fingerprint", { fingerprint: "MZUH-VLPY-MK6X-O3EP" }));
  await v.type(v.fields()[1]!, "not a key");
  expect(v.fields()[1]!.props.error).toBe(en("error.cloud_bad_root"));
  expect(v.button(en("cloud.save")).props.disabled).toBe(true);
});

it("changing the server asks first, and saving signs out and shows Saved", async () => {
  const v = await view();
  await v.type(v.fields()[0]!, "https://license.example.com");
  await v.type(v.fields()[1]!, KEY);
  await v.submit();
  const dialog = v.all().find((n) => n.type === Dialog)!;
  expect(dialog.props.alert).toBe(true);
  expect(dialog.props.title).toBe(en("cloud.confirm.title"));
  expect(v.onServerChange).not.toHaveBeenCalled();
  dialog.props.onConfirm();
  await v.settle();
  expect(v.onServerChange).toHaveBeenCalledTimes(1);
  expect(v.all().some((n) => n.props.role === "status" && n.props.children === en("cloud.saved"))).toBe(true);
  expect(await v.api.cloudSettings()).toEqual({ serverUrl: "https://license.example.com", pinnedRoots: [KEY] });
});

it("an invalid address is refused by the host and shown as an error", async () => {
  const v = await view();
  await v.type(v.fields()[0]!, "ftp://nope");
  await v.type(v.fields()[1]!, KEY);
  await v.submit();
  v.all().find((n) => n.type === Dialog)!.props.onConfirm();
  await v.settle();
  expect(v.all().find((n) => n.props.role === "alert")!.props.children).toBe(en("error.cloud_bad_url"));
});

it("Add key adds a field and Remove last key removes it", async () => {
  const v = await view();
  await v.type(v.fields()[0]!, "https://license.example.com");
  v.button(en("cloud.root.add")).props.onClick();
  await v.settle();
  expect(v.fields()).toHaveLength(3);
  v.button(en("cloud.root.remove")).props.onClick();
  await v.settle();
  expect(v.fields()).toHaveLength(2);
});
