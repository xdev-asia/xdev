import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
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
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

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
  hooks.effects.forEach(effect => effect());
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

it("offers the models of the rule's provider", async () => {
  const view = await harness();
  const options = (n: number) => nodes(view.draw()).filter(x => x.type === "datalist")[n - 1].props.children.map((o: Node) => o.props.value);
  expect(view.field(1, "input", 1).props.list).toBe("routing-models-0");
  expect(options(1)).toEqual(["fable", "opus", "sonnet"]);
  view.button("Add rule").props.onClick();
  expect(options(2)).toEqual(["fable", "opus", "sonnet", "gpt-6.1-sol", "gpt-6-luna", "gpt-5.6-luna"]);
  view.field(2, "select", 1).props.onChange({ target: { value: "codex" } });
  expect(options(2)).toEqual(["gpt-6.1-sol", "gpt-6-luna", "gpt-5.6-luna"]);
});

it("still takes a typed model when the CLIs cannot be asked", async () => {
  const api = createMockApi({}); api.models = () => Promise.reject({ code: "io" });
  const view = await harness(api);
  expect(view.html()).not.toContain('role="alert"');
  view.field(1, "input", 1).props.onChange({ target: { value: "claude-fable-5-1" } });
  expect(view.field(1, "input", 1).props.value).toBe("claude-fable-5-1");
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

const row = (view: Awaited<ReturnType<typeof harness>>, n: number) => nodes(view.draw()).find(x => x.props["aria-label"] === `Row ${n}`)!;
const rowField = (view: Awaited<ReturnType<typeof harness>>, n: number, type: string, at = 0) => nodes(row(view, n)).filter(x => x.type === type)[at];
const status = (view: Awaited<ReturnType<typeof harness>>) => nodes(view.draw()).filter(x => x.props.role === "status" && x.props.className === "routing-match")[0];
const text = (node: Node) => nodes(node.props.children).map(n => typeof n.props.children === "string" ? n.props.children : "").join("") + (typeof node.props.children === "string" ? node.props.children : "");
const testBox = (view: Awaited<ReturnType<typeof harness>>) => nodes(view.draw()).find(x => x.type === "form" && x.props["aria-label"] === "Test a sentence")!;

async function withRows(view: Awaited<ReturnType<typeof harness>>) {
  view.button("Add row").props.onClick();
  rowField(view, 1, "input").props.onChange({ target: { value: "fix typo, rename" } });
  rowField(view, 1, "select").props.onChange({ target: { value: "codex" } });
  rowField(view, 1, "input", 2).props.onChange({ target: { value: "gpt-mini" } });
  view.button("Add row").props.onClick();
  rowField(view, 2, "input").props.onChange({ target: { value: "refactor" } });
  rowField(view, 2, "input", 2).props.onChange({ target: { value: "opus" } });
}

it("adds rows to the match table and saves them with the default row, leaving the rules alone", async () => {
  const view = await harness(); const save = vi.spyOn(view.api, "setRouting");
  await withRows(view);
  expect(row(view, 2)).toBeDefined();
  await view.button("Save rules").props.onClick(); await tick();
  expect(save).toHaveBeenCalledWith({
    rules: [{ role: "review", provider: "claude", maxPrompt: null, model: "haiku" }],
    table: [
      { keywords: ["fix typo", "rename"], target: { agent: "codex", model: "gpt-mini" } },
      { keywords: ["refactor"], target: { agent: "claude", model: "opus" } },
    ],
    fallback: { agent: "claude" },
  });
  expect(view.html()).toContain("Saved. New turns use these rules.");
});

it("does not save a row that has no keyword and no label", async () => {
  const view = await harness(); const save = vi.spyOn(view.api, "setRouting");
  view.button("Add row").props.onClick();
  await view.button("Save rules").props.onClick();
  expect(save).not.toHaveBeenCalled();
  expect(view.html()).toContain("Every row needs a keyword or a task label.");
});

it("tests a sentence and says which row takes it, or that the default row does", async () => {
  const view = await harness();
  await withRows(view);
  const sentence = () => nodes(testBox(view)).filter(x => x.type === "input")[0];
  sentence().props.onChange({ target: { value: "Please refactor the parser" } });
  await testBox(view).props.onSubmit({ preventDefault() {} }); await tick();
  expect(text(status(view))).toBe("Row 2 takes it: claude · opus.");
  expect(row(view, 2).props["data-hit"]).toBe("true");
  expect(row(view, 1).props["data-hit"]).toBeUndefined();

  sentence().props.onChange({ target: { value: "Rename the file" } });
  expect(text(status(view))).toBe("");
  await testBox(view).props.onSubmit({ preventDefault() {} }); await tick();
  expect(text(status(view))).toBe("Row 1 takes it: codex · gpt-mini.");

  sentence().props.onChange({ target: { value: "write a poem" } });
  await testBox(view).props.onSubmit({ preventDefault() {} }); await tick();
  expect(text(status(view))).toBe("No row matches. The default row takes it: claude.");
  expect(nodes(view.draw()).find(x => x.props["aria-label"] === "Default row")!.props["data-hit"]).toBe("true");
});

it("the order of the rows decides which one wins, and a row moves by button or Alt+Arrow", async () => {
  const view = await harness();
  await withRows(view);
  // Both rows now match "refactor rename"; the first wins.
  rowField(view, 2, "input").props.onChange({ target: { value: "refactor, rename" } });
  const sentence = () => nodes(testBox(view)).filter(x => x.type === "input")[0];
  sentence().props.onChange({ target: { value: "refactor rename" } });
  await testBox(view).props.onSubmit({ preventDefault() {} }); await tick();
  expect(text(status(view))).toBe("Row 1 takes it: codex · gpt-mini.");

  expect(view.button("Move row 1 up").props.disabled).toBe(true);
  expect(view.button("Move row 2 down").props.disabled).toBe(true);
  // Alt+ArrowUp inside row 2 moves it above row 1; a plain arrow does nothing.
  const prevent = vi.fn();
  row(view, 2).props.onKeyDown({ key: "ArrowUp", altKey: false, preventDefault: prevent, target: { id: "x" } });
  expect(prevent).not.toHaveBeenCalled();
  row(view, 2).props.onKeyDown({ key: "ArrowUp", altKey: true, preventDefault: prevent, target: { id: "x" } });
  expect(prevent).toHaveBeenCalledTimes(1);
  expect(rowField(view, 1, "input").props.value).toBe("refactor, rename");
  expect(status(view) && text(status(view))).toBe("");
  await testBox(view).props.onSubmit({ preventDefault() {} }); await tick();
  expect(text(status(view))).toBe("Row 1 takes it: claude · opus.");
  // The same move by button.
  view.button("Move row 2 up").props.onClick();
  expect(rowField(view, 1, "input").props.value).toBe("fix typo, rename");
  view.button("Remove row 1").props.onClick();
  expect(rowField(view, 1, "input").props.value).toBe("refactor, rename");
});

it("an old routing without a table loads and tests against the default row", async () => {
  const view = await harness();
  expect(view.html()).toContain("No rows yet: all work goes to the default row.");
  const sentence = nodes(testBox(view)).filter(x => x.type === "input")[0];
  sentence.props.onChange({ target: { value: "anything" } });
  await testBox(view).props.onSubmit({ preventDefault() {} }); await tick();
  expect(text(status(view))).toBe("No row matches. The default row takes it: claude.");
});
