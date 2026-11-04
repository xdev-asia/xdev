import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi, type GitSettings as Git } from "@/api";
import { translate } from "@/i18n";
import { DEFAULT_GIT_SETTINGS, DEMO_WORKSPACE } from "@/mockWorkspace";
import { GitSettings } from "./GitSettings";
import { RecipesEditor } from "./recipes/RecipesEditor";

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

async function view(seed: { gitUserName?: string | null; git?: Partial<Git> } = {}) {
  const api = createMockApi({}, { workspace: { ...structuredClone(DEMO_WORKSPACE), ...seed } });
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return GitSettings({ api, onChanged: vi.fn() }); } finally { hooks.active = false; }
  };
  draw();
  hooks.effects.forEach((e) => e());
  await tick();
  const all = () => nodes(draw());
  const mode = (m: string) => all().find((n) => n.type === "button" && n.props["data-mode"] === m)!;
  const input = () => all().find((n) => n.type === "input" && n.props.name === "branchPrefixCustom");
  const feedback = () => all().find((n) => n.props.id === "settings-git-feedback");
  const toggle = () => all().find((n) => n.props.role === "switch" && n.props["aria-labelledby"] === "settings-git-refresh")!;
  const rename = () => all().find((n) => n.props.role === "switch" && n.props["aria-labelledby"] === "settings-git-autorename")!;
  const ai = () => all().find((n) => n.props.role === "switch" && n.props["aria-labelledby"] === "settings-git-ai")!;
  const check = (name: string) => all().find((n) => n.type === "input" && n.props.type === "checkbox" && n.props.name === name);
  const type = (value: string) => input()!.props.onChange({ target: { value } });
  return { api, all, mode, input, feedback, toggle, rename, ai, check, type, html: () => renderToStaticMarkup(draw()) };
}

it("defaults to the git username, read-only, and previews the branch name", async () => {
  const v = await view({ gitUserName: "duy" });
  expect(v.mode("git-username").props["aria-pressed"]).toBe(true);
  expect(v.input()!.props).toMatchObject({ value: "duy", readOnly: true });
  expect(v.feedback()!.props.children).toBe(en("settings.git.prefixWill", { prefix: "duy" }));
  expect(v.toggle().props["aria-checked"]).toBe(false);
  expect(v.html()).toContain(en("settings.git.refresh"));
});

it("says no git username is configured and no prefix will be applied", async () => {
  const v = await view();
  expect(v.input()!.props).toMatchObject({ value: "", placeholder: en("settings.git.noUserName") });
  expect(v.feedback()!.props.children).toBe(en("settings.git.prefixNone"));
});

it("saves a custom prefix as typed, keeps the raw text and flags a bad one", async () => {
  const v = await view();
  const save = vi.spyOn(v.api, "setGitSettings");
  v.mode("custom").props.onClick();
  await tick();
  expect(save).toHaveBeenLastCalledWith({ ...DEFAULT_GIT_SETTINGS, branchPrefix: "custom" });
  expect(v.input()!.props).toMatchObject({ readOnly: false, placeholder: en("settings.git.customPlaceholder") });

  // A trailing slash on the way to `team/ui` stays in the box.
  v.type("team/");
  expect(v.input()!.props.value).toBe("team/");
  expect(v.feedback()!.props.children).toBe(en("settings.git.prefixWill", { prefix: "team" }));
  v.type("team/ui");
  await tick();
  expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ branchPrefixCustom: "team/ui" }));
  expect(await v.api.gitSettings()).toMatchObject({ branchPrefix: "custom", branchPrefixCustom: "team/ui" });

  v.type("a..b");
  expect(v.feedback()!.props).toMatchObject({ role: "alert", children: en("settings.git.issue.sequence") });
  expect(v.input()!.props["aria-invalid"]).toBe(true);
});

it("hides the prefix field for none and stores the switch and the compare base", async () => {
  const v = await view({ git: { branchPrefix: "custom", branchPrefixCustom: "team" } });
  expect(v.input()!.props.value).toBe("team");
  const compare = (c: string) => v.all().find((n) => n.type === "button" && n.props["data-compare"] === c)!;
  expect(compare("base").props["aria-pressed"]).toBe(true);
  v.mode("none").props.onClick();
  v.toggle().props.onClick();
  compare("upstream").props.onClick();
  await tick();
  expect(v.input()).toBeUndefined();
  expect(v.toggle().props["aria-checked"]).toBe(true);
  expect(compare("upstream").props["aria-pressed"]).toBe(true);
  // Every change lands, in order: each later one builds on the earlier.
  expect(await v.api.gitSettings()).toEqual({ ...DEFAULT_GIT_SETTINGS, branchPrefix: "none", branchPrefixCustom: "team", refreshLocalBaseOnCreate: true, compareAgainstUpstream: true });
});

it("shows the agent actions on by default with the pull request defaults off, and stores each", async () => {
  const v = await view();
  expect(v.html()).toContain(en("settings.git.ai.title"));
  expect(v.ai().props["aria-checked"]).toBe(true);
  for (const name of ["prDraft", "prGenerateOnOpen", "prOpenAfterCreate"]) {
    expect(v.check(name)!.props.checked, name).toBe(false);
    v.check(name)!.props.onChange();
  }
  await tick();
  expect(await v.api.gitSettings()).toMatchObject({ sourceControlAi: true, prDraft: true, prGenerateOnOpen: true, prOpenAfterCreate: true });
});

it("hides the pull request defaults while the agent actions are off", async () => {
  const v = await view({ git: { prDraft: true } });
  v.ai().props.onClick();
  await tick();
  expect(v.ai().props["aria-checked"]).toBe(false);
  expect(v.check("prDraft")).toBeUndefined();
  // Hidden is not cleared: they come back as they were.
  expect(await v.api.gitSettings()).toMatchObject({ sourceControlAi: false, prDraft: true });
  v.ai().props.onClick();
  expect(v.check("prDraft")!.props.checked).toBe(true);
});

it("shows a failed save", async () => {
  const v = await view();
  vi.spyOn(v.api, "setGitSettings").mockRejectedValue({ code: "io", message: "disk" });
  v.toggle().props.onClick();
  await tick();
  expect(v.all().find((n) => n.props.role === "alert")?.props.children).toBe(en("error.io"));
});

it("shows the recipes with the agent actions, and saves an edit through the git settings", async () => {
  const v = await view();
  // The Source Control editor lists its own recipes; the Advanced one lists only the branch name.
  const editor = () => v.all().find((n) => n.type === RecipesEditor && !n.props.ids)!;
  expect(editor()).toBeDefined();
  const save = vi.spyOn(v.api, "setGitSettings");
  const recipes = structuredClone(DEFAULT_GIT_SETTINGS.recipes);
  recipes.commitMessage.template = "Use conventional commits.\n{basePrompt}";
  editor().props.onChange(recipes);
  await tick();
  expect(save).toHaveBeenLastCalledWith({ ...DEFAULT_GIT_SETTINGS, recipes });
  v.ai().props.onClick();
  await tick();
  expect(v.all().find((n) => n.type === RecipesEditor && !n.props.ids)).toBeUndefined();
});

it("turns auto rename on by default, stores the switch, and keeps the branch name recipe under Advanced", async () => {
  const v = await view();
  expect(v.rename().props["aria-checked"]).toBe(true);
  v.rename().props.onClick();
  await tick();
  expect(v.rename().props["aria-checked"]).toBe(false);
  expect(await v.api.gitSettings()).toMatchObject({ autoRenameBranch: false });

  const advanced = v.all().find((n) => n.type === "details" && n.props["data-advanced"] === "branch-name")!;
  expect(nodes(advanced).find((n) => n.type === "summary")!.props.children).toBe(en("settings.git.autoRename.advanced"));
  const editor = nodes(advanced).find((n) => n.type === RecipesEditor)!;
  expect(editor.props.ids).toEqual(["branchName"]);
  const recipes = structuredClone(DEFAULT_GIT_SETTINGS.recipes);
  recipes.branchName.template = "Short name for: {firstPrompt}";
  editor.props.onChange(recipes);
  await tick();
  expect(await v.api.gitSettings()).toMatchObject({ recipes: { branchName: { template: "Short name for: {firstPrompt}" } } });
});

it("keeps the auto rename switch while the agent actions are off", async () => {
  const v = await view();
  v.ai().props.onClick();
  await tick();
  expect(v.rename()).toBeDefined();
});

it("stores the source control group order", async () => {
  const v = await view({});
  const order = (o: string) => v.all().find((n) => n.type === "button" && n.props["data-group-order"] === o)!;
  expect(order("changes-first").props["aria-pressed"]).toBe(true);
  order("staged-first").props.onClick();
  await tick();
  expect(order("staged-first").props["aria-pressed"]).toBe(true);
  expect(await v.api.gitSettings()).toEqual({ ...DEFAULT_GIT_SETTINGS, sourceControlGroupOrder: "staged-first" });
});
