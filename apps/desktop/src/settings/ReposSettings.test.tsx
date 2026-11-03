import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "@xdev/ui";
import { createMockApi, type RepoView } from "../api";
import { translate } from "../i18n";
import { DEMO_WORKSPACE } from "../mockWorkspace";
import { ReposSettings } from "./ReposSettings";

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
vi.mock("../i18n", async (original) => ({ ...await original<typeof import("../i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

const other: RepoView = { ...structuredClone(DEMO_WORKSPACE.repos[0]), id: "demo-tools", shortName: "tools", path: "/demo/tools", worktreeRoot: "/demo/wt", worktrees: [], found: [] };

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false; });

async function view() {
  const api = createMockApi({}, { workspace: { ...structuredClone(DEMO_WORKSPACE), repos: [structuredClone(DEMO_WORKSPACE.repos[0]), other] } });
  const onChanged = vi.fn();
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return ReposSettings({ api, onChanged }); } finally { hooks.active = false; }
  };
  draw();
  hooks.effects.forEach((e) => e());
  await tick();
  const all = () => nodes(draw());
  const form = (id: string) => all().find((n) => n.type === "form" && n.key === id)!;
  const field = (id: string, name: string) => nodes(form(id)).find((n) => n.type === "input" && n.props.name === name)!;
  const type = (id: string, name: string, value: string) => field(id, name).props.onChange({ target: { value } });
  const submit = async (id: string) => { form(id).props.onSubmit({ preventDefault() {} }); await tick(); };
  const error = (id: string, name: string) => all().find((n) => n.props.id === `settings-${id}-${name}-error`);
  const save = (id: string) => nodes(form(id)).find((n) => n.type === Button)!;
  const html = () => renderToStaticMarkup(draw());
  return { api, onChanged, all, form, field, type, submit, error, save, html };
}

it("saves a changed short name and shows short_name_taken inline", async () => {
  const v = await view();
  const update = vi.spyOn(v.api, "repoUpdate");
  expect(v.html()).toContain(en("settings.repos.shortNameNote"));
  expect(v.save("demo-xdev").props.disabled).toBe(true);

  v.type("demo-xdev", "shortName", "tools");
  expect(v.save("demo-xdev").props.disabled).toBe(false);
  await v.submit("demo-xdev");
  expect(update).toHaveBeenLastCalledWith("demo-xdev", { shortName: "tools" });
  expect(v.error("demo-xdev", "shortName")?.props.children).toBe(en("error.short_name_taken"));
  expect(v.field("demo-xdev", "shortName").props["aria-invalid"]).toBe(true);
  expect(v.field("demo-xdev", "shortName").props["aria-describedby"]).toBe("settings-demo-xdev-shortName-error");
  expect(v.onChanged).not.toHaveBeenCalled();

  // Only the changed field goes, trimmed.
  v.type("demo-xdev", "shortName", " xd ");
  await v.submit("demo-xdev");
  expect(update).toHaveBeenLastCalledWith("demo-xdev", { shortName: "xd" });
  expect(v.error("demo-xdev", "shortName")).toBeUndefined();
  expect(v.field("demo-xdev", "shortName").props.value).toBe("xd");
  expect(v.all().some((n) => n.props.className === "settings-saved")).toBe(true);
  expect(v.onChanged).toHaveBeenCalledTimes(1);
  expect((await v.api.workspaceList()).find((r) => r.id === "demo-xdev")!.shortName).toBe("xd");
});

it("bad_ref shows under base ref and keeps the typed value", async () => {
  const v = await view();
  v.type("demo-xdev", "baseRef", "a..b");
  await v.submit("demo-xdev");
  expect(v.error("demo-xdev", "baseRef")?.props.children).toBe(en("error.bad_ref"));
  expect(v.error("demo-xdev", "shortName")).toBeUndefined();
  expect(v.field("demo-xdev", "baseRef").props.value).toBe("a..b");
  expect((await v.api.workspaceList())[0].baseRef).toBe("main");
});

it("a worktree folder inside the checkout shows the folder rule", async () => {
  const v = await view();
  v.type("demo-xdev", "worktreeRoot", "/demo/xdev/wt");
  await v.submit("demo-xdev");
  expect(v.error("demo-xdev", "worktreeRoot")?.props.children).toBe(en("settings.repos.badRoot"));
});

it("a bad short name shows the naming rule", async () => {
  const v = await view();
  v.type("demo-xdev", "shortName", "Bad Name");
  await v.submit("demo-xdev");
  expect(v.error("demo-xdev", "shortName")?.props.children).toBe(en("settings.repos.badName"));
});
