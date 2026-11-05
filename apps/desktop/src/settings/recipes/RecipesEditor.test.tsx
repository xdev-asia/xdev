import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { createMockApi, type GitRecipes } from "@/api";
import { translate } from "@/i18n";
import { DEFAULT_GIT_SETTINGS } from "../gitDefaults";
import { RecipesEditor, insertAt } from "./RecipesEditor";

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

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false; });

async function mount(recipes: GitRecipes = DEFAULT_GIT_SETTINGS.recipes) {
  const api = createMockApi({});
  const onChange = vi.fn<(next: GitRecipes) => void>();
  let current = recipes;
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return RecipesEditor({ api, recipes: current, onChange: (next) => { current = next; onChange(next); } }); } finally { hooks.active = false; }
  };
  draw();
  hooks.effects.forEach((e) => e());
  await tick();
  const all = () => nodes(draw());
  const row = (id: string) => nodes(draw()).find((n) => n.type === "details" && n.props["data-recipe"] === id)!;
  const within = (id: string) => nodes(row(id));
  const field = (id: string, type: string, name: string) => within(id).find((n) => n.type === type && n.props.name === `recipe-${id}-${name}`);
  const chip = (id: string, name: string) => within(id).find((n) => n.type === "button" && n.props["data-var"] === name)!;
  const reset = (id: string) => within(id).find((n) => n.type === "button" && n.props["data-reset"] === id)!;
  const preview = (id: string) => within(id).find((n) => n.type === "pre")!.props.children as string;
  return { onChange, all, row, within, field, chip, reset, preview };
}

it("lists the six recipes with their variables, and args only for the drafts", async () => {
  const v = await mount();
  const ids = v.all().filter((n) => n.type === "details").map((n) => n.props["data-recipe"]);
  expect(ids).toEqual(["commitMessage", "pullRequest", "fixCommitFailure", "fixPushFailure", "fixChecks", "resolveConflicts"]);
  expect(v.field("resolveConflicts", "input", "args")).toBeUndefined();
  const conflict = v.within("resolveConflicts").filter((n) => n.props["data-var"]).map((n) => n.props["data-var"]);
  expect(conflict).toEqual(["basePrompt", "branch", "operation", "files", "onto"]);
  expect(v.field("commitMessage", "input", "args")).toBeDefined();
  expect(v.field("pullRequest", "input", "args")).toBeDefined();
  for (const id of ["fixCommitFailure", "fixPushFailure", "fixChecks"]) expect(v.field(id, "input", "args")).toBeUndefined();
  const names = v.within("fixChecks").filter((n) => n.props["data-var"]).map((n) => n.props["data-var"]);
  expect(names).toEqual(["basePrompt", "branch", "checkName", "workflow", "link", "log"]);
});

it("lists only the asked recipes without the heading, and the branch name one drafts", async () => {
  const api = createMockApi({});
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return RecipesEditor({ api, recipes: DEFAULT_GIT_SETTINGS.recipes, onChange: vi.fn(), ids: ["branchName"], heading: false }); } finally { hooks.active = false; }
  };
  draw();
  hooks.effects.forEach((e) => e());
  await tick();
  const all = nodes(draw());
  expect(all.filter((n) => n.type === "details").map((n) => n.props["data-recipe"])).toEqual(["branchName"]);
  expect(all.find((n) => n.type === "h4")).toBeUndefined();
  // It runs through a runner like the drafts: args, and Claude or Codex only.
  expect(all.find((n) => n.type === "input" && n.props.name === "recipe-branchName-args")).toBeDefined();
  const names = all.filter((n) => n.props["data-var"]).map((n) => n.props["data-var"]);
  expect(names).toEqual(["basePrompt", "firstPrompt", "assistantMessage"]);
  const select = all.find((n) => n.type === "select")!;
  expect(nodes(select).filter((n) => n.type === "option").map((n) => n.props.value)).toEqual(["", "claude", "codex"]);
});

it("offers the default agent first, and only Claude and Codex for a draft", async () => {
  const v = await mount();
  const options = (id: string) => nodes(v.field(id, "select", "agent")).filter((n) => n.type === "option").map((n) => n.props.value);
  expect(options("commitMessage")).toEqual(["", "claude", "codex"]);
  expect(options("fixChecks")).toEqual(["", ...["claude", "codex", "gemini", "cursor", "copilot", "opencode", "amp", "droid", "qwen-code", "kimi", "devin", "aider", "goose"]]);
  expect(nodes(v.field("pullRequest", "select", "agent"))[1]!.props.children).toBe(en("settings.git.recipes.defaultAgent"));
});

it("keeps showing an agent a draft cannot use, so it can be changed", async () => {
  const recipes = structuredClone(DEFAULT_GIT_SETTINGS.recipes);
  recipes.commitMessage.agent = "gemini";
  const v = await mount(recipes);
  const select = v.field("commitMessage", "select", "agent")!;
  expect(select.props.value).toBe("gemini");
  const last = nodes(select).filter((n) => n.type === "option").at(-1)!;
  expect(last.props.children).toBe(en("settings.git.recipes.unsupportedAgent", { name: "gemini" }));
});

it("saves a chosen agent, and none for the default", async () => {
  const v = await mount();
  v.field("pullRequest", "select", "agent")!.props.onChange({ target: { value: "codex" } });
  expect(v.onChange.mock.lastCall![0].pullRequest).toEqual({ agent: "codex", args: [], template: "{basePrompt}" });
  v.field("pullRequest", "select", "agent")!.props.onChange({ target: { value: "" } });
  expect(v.onChange.mock.lastCall![0].pullRequest.agent).toBeNull();
});

it("saves the template as typed and previews it with sample values", async () => {
  const v = await mount();
  const box = v.field("commitMessage", "textarea", "template")!;
  box.props.onChange({ target: { value: "Use conventional commits.\n{basePrompt}\nOn {branch}. {nope} {{x}}", selectionStart: 3, selectionEnd: 3 } });
  expect(v.onChange.mock.lastCall![0].commitMessage.template).toBe("Use conventional commits.\n{basePrompt}\nOn {branch}. {nope} {{x}}");
  expect(v.preview("commitMessage")).toBe(`Use conventional commits.\n${en("settings.git.recipes.sampleBase")}\nOn feat/login-form. {nope} {x}`);
});

it("splits typed args and keeps the typed text", async () => {
  const v = await mount();
  v.field("commitMessage", "input", "args")!.props.onChange({ target: { value: '--model "gpt 5" ' } });
  expect(v.onChange.mock.lastCall![0].commitMessage.args).toEqual(["--model", "gpt 5"]);
  expect(v.field("commitMessage", "input", "args")!.props.value).toBe('--model "gpt 5" ');
});

it("inserts a variable at the caret, over a selection, or at the end", async () => {
  const v = await mount();
  // No caret yet: at the end.
  v.chip("fixPushFailure", "branch").props.onClick();
  expect(v.onChange.mock.lastCall![0].fixPushFailure.template).toBe("{basePrompt}{branch}");
  // The caret the box last reported; the new one follows the inserted text.
  const box = v.field("fixPushFailure", "textarea", "template")!;
  box.props.onSelect({ currentTarget: { selectionStart: 0, selectionEnd: 12 } });
  v.chip("fixPushFailure", "output").props.onClick();
  expect(v.onChange.mock.lastCall![0].fixPushFailure.template).toBe("{output}{branch}");
  v.chip("fixPushFailure", "basePrompt").props.onClick();
  expect(v.onChange.mock.lastCall![0].fixPushFailure.template).toBe("{output}{basePrompt}{branch}");
  // Another recipe is untouched.
  expect(v.onChange.mock.lastCall![0].commitMessage.template).toBe("{basePrompt}");
  // A press on a chip keeps the focus in the template box.
  const down = vi.fn();
  v.chip("fixPushFailure", "branch").props.onMouseDown({ preventDefault: down });
  expect(down).toHaveBeenCalled();
});

it("insertAt clamps a caret past the end", () => {
  expect(insertAt("ab", { start: 9, end: 9 }, "{x}")).toEqual({ text: "ab{x}", caret: { start: 5, end: 5 } });
  expect(insertAt("abcd", { start: 1, end: 3 }, "-")).toEqual({ text: "a-d", caret: { start: 2, end: 2 } });
});

it("resets one recipe to the default, and is off while it is the default", async () => {
  const recipes = structuredClone(DEFAULT_GIT_SETTINGS.recipes);
  recipes.fixChecks = { agent: "codex", args: ["-x"], template: "mine" };
  const v = await mount(recipes);
  expect(v.reset("commitMessage").props.disabled).toBe(true);
  expect(v.reset("fixChecks").props.disabled).toBe(false);
  v.reset("fixChecks").props.onClick();
  expect(v.onChange.mock.lastCall![0]).toEqual(DEFAULT_GIT_SETTINGS.recipes);
});

it("warns when a template is longer than what is saved", async () => {
  const recipes = structuredClone(DEFAULT_GIT_SETTINGS.recipes);
  recipes.commitMessage.template = "x".repeat(16 * 1024 + 1);
  const v = await mount(recipes);
  expect(v.within("commitMessage").some((n) => n.props.role === "alert")).toBe(true);
  expect(v.within("pullRequest").some((n) => n.props.role === "alert")).toBe(false);
});
