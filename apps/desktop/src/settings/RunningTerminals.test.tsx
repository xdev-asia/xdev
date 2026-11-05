import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { RunningTerminals } from "./RunningTerminals";

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

beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
  hooks.effects = [];
  hooks.active = false;
});

async function view(setup: (api: ReturnType<typeof createMockApi>) => void) {
  const api = createMockApi({});
  setup(api);
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return RunningTerminals({ api }); } finally { hooks.active = false; }
  };
  draw();
  hooks.effects.splice(0).forEach((e) => e());
  await tick();
  const all = () => nodes(draw());
  const button = (label: string) => all().find((n) => n.type === "button" && n.props.children === label);
  const rows = () => all().filter((n) => n.props["data-session"] !== undefined);
  const dialog = () => all().find((n) => n.props.confirmLabel !== undefined)!;
  return { api, all, button, rows, dialog };
}

const running = (api: ReturnType<typeof createMockApi>) => {
  api.__ptydSet({ state: "running", serviceVersion: "0.4.0" });
  api.__ptydHold({ id: "a", meta: { worktree: "/w/oak", tabId: "a", profile: "claude" } });
  api.__ptydHold({ id: "b", meta: { worktree: "/w/elm", tabId: "b", profile: "shell" } });
};

it("lists the service's terminals with their worktree", async () => {
  const v = await view(running);
  expect(v.rows().map((r) => r.props["data-session"])).toEqual(["a", "b"]);
  expect(JSON.stringify(v.rows()[0].props.children)).toContain("/w/oak");
  expect(v.dialog().props.open).toBe(false);
});

it("End on a row asks, then ends that one", async () => {
  const v = await view(running);
  const end = vi.spyOn(v.api, "ptydEnd");
  nodes(v.rows()[0]).find((n) => n.type === "button")!.props.onClick();
  expect(v.dialog().props.open).toBe(true);
  expect(end).not.toHaveBeenCalled();
  v.dialog().props.onConfirm();
  await tick();
  expect(end).toHaveBeenCalledWith("a");
  expect(v.rows().map((r) => r.props["data-session"])).toEqual(["b"]);
  expect(v.dialog().props.open).toBe(false);
});

it("End all and Restart name the count in their question", async () => {
  const v = await view(running);
  const endAll = vi.spyOn(v.api, "ptydEndAll");
  v.button(en("settings.terminal.service.endAll"))!.props.onClick();
  expect(v.dialog().props.title).toBe(en("settings.terminal.service.endAllTitle", { count: 2 }));
  v.dialog().props.onCancel();
  expect(v.dialog().props.open).toBe(false);
  expect(endAll).not.toHaveBeenCalled();

  const restart = vi.spyOn(v.api, "ptydRestart");
  v.button(en("settings.terminal.service.restart"))!.props.onClick();
  expect(v.dialog().props.body).toBe(en("settings.terminal.service.restartBody", { count: 2 }));
  v.dialog().props.onConfirm();
  await tick();
  expect(restart).toHaveBeenCalledTimes(1);
  expect(v.rows()).toEqual([]);
});

it("says so when the service is not running, with no actions", async () => {
  const v = await view(() => {});
  expect(JSON.stringify(v.all().map((n) => n.props.children))).toContain(en("settings.terminal.service.off"));
  expect(v.button(en("settings.terminal.service.endAll"))).toBeUndefined();
});

it("an older service says which version it is from and to restart it", async () => {
  const v = await view((api) => {
    api.__ptydSet({ state: "old-version", serviceVersion: "0.3.9" });
  });
  expect(JSON.stringify(v.all().map((n) => n.props.children))).toContain(en("ptyd.oldVersion", { version: "0.3.9" }));
  expect(v.button(en("settings.terminal.service.restart"))).toBeDefined();
});

const buttonsOf = (row: Node) => nodes(row).filter((n) => n.type === "button").map((n) => n.props.children);

it("clear confirms then calls ptydClearScrollback", async () => {
  const v = await view((api) => {
    running(api);
    api.__ptydSet({ state: "running", serviceVersion: "0.4.0", features: ["clear"] });
  });
  const clear = vi.spyOn(v.api, "ptydClearScrollback");
  const row = v.rows()[0];
  nodes(row).find((n) => n.type === "button" && n.props.children === en("settings.terminal.service.clear"))!.props.onClick();
  expect(v.dialog().props.title).toBe(en("settings.terminal.service.clearTitle"));
  expect(clear).not.toHaveBeenCalled();
  v.dialog().props.onConfirm();
  await tick();
  expect(clear).toHaveBeenCalledWith("a");
});

it("clear hidden without feature", async () => {
  const v = await view(running);
  expect(buttonsOf(v.rows()[0])).not.toContain(en("settings.terminal.service.clear"));
});

it("go to hidden when no owner", async () => {
  const v = await view(running);
  expect(buttonsOf(v.rows()[0])).not.toContain(en("settings.terminal.service.goTo"));
});

it("go to asks the workspace for that terminal's tab", async () => {
  const { onTabJump } = await import("@/workspace/tabJump");
  const seen: string[] = [];
  const off = onTabJump((id) => (seen.push(id), true));
  const v = await view((api) => {
    running(api);
    void api.ptyAttach("a", 0, () => {});
  });
  await tick();
  const go = nodes(v.rows()[0]).find((n) => n.type === "button" && n.props.children === en("settings.terminal.service.goTo"))!;
  go.props.onClick();
  off();
  expect(seen).toEqual(["a"]);
});
