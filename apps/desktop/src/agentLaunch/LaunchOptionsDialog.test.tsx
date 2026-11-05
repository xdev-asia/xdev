import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Button, Dialog, Field, Select } from "@xdev-asia/ui";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { LaunchOptionsDialog } from "./LaunchOptionsDialog";
import { PromptComposer } from "./PromptComposer";

const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return index;
  };
  return {
    ...react,
    useState: (initial: unknown) => {
      if (!hooks.active) return react.useState(initial);
      const values = hooks.values;
      const index = slot(initial);
      return [values[index], (v: unknown) => { values[index] = typeof v === "function" ? (v as (x: unknown) => unknown)(values[index]) : v; }];
    },
    useEffect: (effect: any, deps?: any) => (hooks.active ? undefined : react.useEffect(effect, deps)),
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
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

async function open(id: string) {
  const api = createMockApi({});
  const view = (await api.profiles()).profiles.find((p) => p.profile.id === id)!;
  const onLaunch = vi.fn();
  const onCancel = vi.fn();
  const values: unknown[] = [];
  const draw = () => {
    hooks.values = values;
    hooks.cursor = 0;
    hooks.active = true;
    try { return LaunchOptionsDialog({ api, profile: view, worktree: "/demo/wt", onLaunch, onCancel }); } finally { hooks.active = false; }
  };
  draw();
  const all = () => nodes(draw());
  const selects = () => all().filter((n) => n.type === Select);
  const field = (label: string) => all().find((n) => n.type === Field && n.props.label === en(label))!;
  const dialog = () => all().find((n) => n.type === Dialog)!;
  const composer = () => all().find((n) => n.type === PromptComposer)!;
  const check = () => all().find((n) => n.type === Button)!;
  return { api, onLaunch, onCancel, selects, field, dialog, composer, check, all };
}

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.active = false; });

it("launches with nothing changed as no overrides and no prompt", async () => {
  const d = await open("claude");
  d.dialog().props.onConfirm();
  expect(d.onLaunch).toHaveBeenCalledWith({ overrides: null, prompt: null });
});

it("offers the agent's known models, the profile default first and a custom entry last", async () => {
  const d = await open("claude");
  const options = d.selects()[0]!.props.options.map((o: { value: string }) => o.value);
  expect(options).toEqual(["", "opus", "sonnet", "haiku", "__custom"]);
  expect(d.selects()[0]!.props.options[0].label).toBe(en("agentLaunch.model.default"));
});

it("an agent without effort has no effort control", async () => {
  expect((await open("claude")).selects()).toHaveLength(2);
  expect((await open("aider")).selects()).toHaveLength(1);
});

it("hands back the chosen model, effort, split arguments and the prompt", async () => {
  const d = await open("claude");
  d.selects()[0]!.props.onChange({ target: { value: "opus" } });
  d.selects()[1]!.props.onChange({ target: { value: "high" } });
  d.field("agentLaunch.args").props.onChange({ target: { value: `--add-dir "my dir"` } });
  d.composer().props.onChange("fix it @src/a.ts");
  d.dialog().props.onConfirm();
  expect(d.onLaunch).toHaveBeenCalledWith({
    overrides: { model: "opus", effort: "high", extraArgs: ["--add-dir", "my dir"] },
    prompt: "fix it @src/a.ts",
  });
});

it("a typed model replaces the list's", async () => {
  const d = await open("aider");
  d.selects()[0]!.props.onChange({ target: { value: "__custom" } });
  d.field("agentLaunch.model.customLabel").props.onChange({ target: { value: "my-model" } });
  d.dialog().props.onConfirm();
  expect(d.onLaunch).toHaveBeenCalledWith({ overrides: { model: "my-model", effort: null, extraArgs: [] }, prompt: null });
});

it("an open quote shows the error and keeps Launch off", async () => {
  const d = await open("claude");
  expect(d.dialog().props.confirmDisabled).toBe(false);
  d.field("agentLaunch.args").props.onChange({ target: { value: `--x "oops` } });
  expect(d.dialog().props.confirmDisabled).toBe(true);
  expect(d.field("agentLaunch.args").props.error).toBe(en("agentLaunch.args.bad"));
});

it("Check asks the agent's version check and shows the verdict", async () => {
  const d = await open("claude");
  const probe = vi.spyOn(d.api, "agentProbe");
  d.check().props.onClick();
  await tick();
  expect(probe).toHaveBeenCalledWith("claude");
  expect(d.all().some((n) => n.props.role === "status" && n.props.children === en("agentLaunch.verdict.ok", { agent: "Claude Code", version: "1.0.0" }))).toBe(true);
});

it("Check says the agent is not installed", async () => {
  const d = await open("gemini");
  d.check().props.onClick();
  await tick();
  expect(d.all().some((n) => n.props.role === "status" && String(n.props.children).includes("not installed"))).toBe(true);
});

it("Cancel leaves without launching", async () => {
  const d = await open("claude");
  d.dialog().props.onCancel();
  expect(d.onCancel).toHaveBeenCalled();
  expect(d.onLaunch).not.toHaveBeenCalled();
});
