import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi } from "../api";
import { translate } from "../i18n";
import { RoutingRules } from "./RoutingRules";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value; }];
  },
  useEffect: (effect: () => void) => { hooks.effects.push(effect); },
}));
vi.mock("../i18n", async (original) => ({ ...await original<typeof import("../i18n")>(), useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
async function harness(api = createMockApi({})) {
  const draw = () => { hooks.cursor = 0; return RoutingRules({ api }); };
  draw();
  hooks.effects[0]();
  await tick();
  const html = () => renderToStaticMarkup(draw());
  const button = (text: string) => nodes(draw()).find(n => (n.props["aria-label"] === text || n.props.children === text) && n.props.onClick)!;
  const rule = (n: number) => nodes(draw()).find(x => x.props["aria-label"] === `Rule ${n}`)!;
  const field = (n: number, type: string, at = 0) => nodes(rule(n)).filter(x => x.type === type)[at];
  return { api, draw, html, button, rule, field };
}
beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; });

it("loads the saved rules", async () => {
  const view = await harness();
  const html = view.html();
  expect(html).toContain("Model routing");
  expect(html).toContain('value="haiku"');
  expect(view.field(1, "select").props.value).toBe("review");
  expect(view.field(1, "select", 1).props.value).toBe("claude");
});

it("does not save a rule without a model", async () => {
  const view = await harness(); const save = vi.spyOn(view.api, "setRouting");
  view.button("Add rule").props.onClick();
  expect(view.rule(2)).toBeDefined();
  await view.button("Save rules").props.onClick();
  expect(save).not.toHaveBeenCalled();
  expect(view.html()).toContain(translate("en", "error.empty_text"));
});

it("saves edited rules with trimmed models", async () => {
  const view = await harness(); const save = vi.spyOn(view.api, "setRouting");
  view.button("Add rule").props.onClick();
  view.field(2, "select").props.onChange({ target: { value: "task" } });
  view.field(2, "input").props.onChange({ target: { value: "1200" } });
  view.field(2, "input", 1).props.onChange({ target: { value: "  sonnet " } });
  view.field(1, "select", 1).props.onChange({ target: { value: "" } });
  await view.button("Save rules").props.onClick(); await tick();
  expect(save).toHaveBeenCalledWith({ rules: [
    { role: "review", provider: null, maxPrompt: null, model: "haiku" },
    { role: "task", provider: null, maxPrompt: 1200, model: "sonnet" },
  ] });
  expect(view.html()).toContain("Saved. New turns use these rules.");
  expect(await view.api.routing()).toEqual(save.mock.calls[0][0]);
});

it("reorders and removes rules", async () => {
  const view = await harness();
  view.button("Add rule").props.onClick();
  view.field(2, "input", 1).props.onChange({ target: { value: "sonnet" } });
  expect(view.button("Move rule 1 up").props.disabled).toBe(true);
  view.button("Move rule 2 up").props.onClick();
  expect(view.field(1, "input", 1).props.value).toBe("sonnet");
  view.button("Remove rule 1").props.onClick();
  expect(view.field(1, "input", 1).props.value).toBe("haiku");
  view.button("Remove rule 1").props.onClick();
  expect(view.html()).toContain("No rules yet");
});
