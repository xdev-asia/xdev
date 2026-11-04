import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { DEMO_POLICY_PATH } from "@/mockTasks";
import { ConfirmDialog } from "./ConfirmDialog";
import { DiffView } from "./DiffView";
import { TasksView } from "./TasksView";

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
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

async function harness(api = createMockApi({}), defaultRepo?: string | null) {
  const draw = () => { hooks.cursor = 0; return TasksView({ api, defaultRepo }); };
  const html = () => renderToStaticMarkup(draw());
  const all = () => nodes(draw());
  const button = (text: string) => all().find(n => n.props.children === text && n.props.onClick)!;
  const items = () => all().filter(n => n.props.className === "task-item");
  draw();
  // The first two effects load the tasks and the accounts.
  hooks.effects[0](); hooks.effects[1](); await tick();
  const reload = async () => { draw(); hooks.effects.at(-3)!(); await tick(); };
  return { api, draw, html, all, button, items, reload };
}
beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; });

it("lists tasks newest first with a state badge and the first goal line", async () => {
  const view = await harness();
  const html = view.html();
  expect(html).toContain("Retry failed fetches up to three times");
  expect(html.indexOf("Retry failed fetches")).toBeLessThan(html.indexOf("Fix broken links in the docs"));
  expect(html.indexOf("Fix broken links in the docs")).toBeLessThan(html.indexOf("Add a quick start"));
  for (const state of ["review", "failed", "merged"]) expect(html).toContain(`data-state="${state}"`);
  expect(view.items()).toHaveLength(3);
});

it("shows the evidence of the selected task and a file diff", async () => {
  const view = await harness();
  const html = view.html();
  expect(html).toContain("xdev/task-20261102-0900-retry-fetch");
  expect(html).toContain("$0.4213");
  expect(html).toContain("src/retry.ts");
  expect(html).toContain("+4");
  expect(html).toContain("+-");
  expect(html).toContain(en("tasks.testExit", { code: 0 }));
  expect(html).toContain("Test Files  1 passed (1)");

  const file = (path: string) => view.all().find(n => n.props.className === "task-file" && nodes(n.props.children).some(c => c.props.children === path))!;
  await file("src/retry.ts").props.onClick(); await tick();
  const diff = view.all().find(n => n.type === DiffView)!;
  expect(diff.props.base).toContain("fetchJson(url: string)");
  expect(diff.props.current).toContain("tries = 3");

  await file("assets/logo.png").props.onClick(); await tick();
  expect(view.html()).toContain(en("error.binary"));
});

it("enables the actions that fit each state", async () => {
  const view = await harness();
  const disabled = () => Object.fromEntries(["tasks.runAction", "tasks.resume", "tasks.approve", "tasks.discard"].map(k => [k, Boolean(view.button(en(k)).props.disabled)]));
  expect(disabled()).toEqual({ "tasks.runAction": true, "tasks.resume": true, "tasks.approve": false, "tasks.discard": false });
  view.items()[1].props.onClick();
  expect(disabled()).toEqual({ "tasks.runAction": false, "tasks.resume": false, "tasks.approve": true, "tasks.discard": false });
  view.items()[2].props.onClick();
  expect(disabled()).toEqual({ "tasks.runAction": true, "tasks.resume": true, "tasks.approve": true, "tasks.discard": true });
});

it("shows the gate's reason and the policy file without a way to loosen it", async () => {
  const view = await harness();
  view.items()[1].props.onClick();
  view.all().find(n => n.type === "input" && n.props.spellCheck === false)!.props.onChange({ target: { value: "pnpm test" } });
  await view.button(en("tasks.runAction")).props.onClick(); await tick();
  const html = view.html();
  expect(html).toContain(en("error.needs_approval"));
  expect(html).toContain(en("tasks.reason", { reason: "command requires approval: pnpm" }));
  expect(html).toContain(DEMO_POLICY_PATH);
  const banner = view.all().find(n => n.props.role === "alert")!;
  expect(nodes(banner).filter(n => n.type === "button" || n.props.onClick)).toEqual([]);
});

it("asks before approving and merges only once confirmed", async () => {
  const view = await harness();
  const approve = vi.spyOn(view.api, "approveTask");
  view.button(en("tasks.approve")).props.onClick();
  expect(approve).not.toHaveBeenCalled();
  let dialog = view.all().find(n => n.type === ConfirmDialog)!;
  expect(dialog.props.open).toBe(true);
  expect(dialog.props.body).toContain("xdev/task-20261102-0900-retry-fetch");
  dialog.props.onCancel();
  expect(view.all().find(n => n.type === ConfirmDialog)!.props.open).toBe(false);
  expect(approve).not.toHaveBeenCalled();

  view.button(en("tasks.approve")).props.onClick();
  dialog = view.all().find(n => n.type === ConfirmDialog)!;
  dialog.props.onConfirm(); await tick();
  expect(approve).toHaveBeenCalledWith("20261102-0900-retry-fetch");
  await view.reload();
  expect(view.html()).toContain(en("tasks.merged", { commit: "4444444444" }));
});

it("shows a run as running while it is out and refreshes when it ends", async () => {
  vi.useFakeTimers();
  try {
    const api = createMockApi({}, { runDelayMs: 1000 });
    const view = await harness(api);
    view.items()[1].props.onClick();
    const done = view.button(en("tasks.runAction")).props.onClick(); await tick();
    expect(view.html()).toContain(en("tasks.working"));
    expect(view.button(en("tasks.runAction")).props.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(1000); await done;
    await view.reload();
    const html = view.html();
    expect(html).not.toContain(en("tasks.working"));
    expect(html.match(/data-state="review"/g)!.length).toBeGreaterThanOrEqual(2);
  } finally {
    vi.useRealTimers();
  }
});

it("creates a task in the default repo", async () => {
  const view = await harness();
  const create = vi.spyOn(view.api, "newTask");
  view.button(en("tasks.new")).props.onClick();
  view.all().find(n => n.type === "textarea")!.props.onChange({ target: { value: "Write a changelog" } });
  await view.all().find(n => n.type === "form")!.props.onSubmit({ preventDefault() {} }); await tick();
  expect(create).toHaveBeenCalledWith((await view.api.tasksContext()).defaultRepo, "Write a changelog");
  await view.reload();
  expect(view.html()).toContain("Write a changelog");
});

it("creates a task in the repo the host passes, ahead of the app default", async () => {
  const view = await harness(createMockApi({}), "/p/shared");
  const create = vi.spyOn(view.api, "newTask");
  view.button(en("tasks.new")).props.onClick();
  view.all().find(n => n.type === "textarea")!.props.onChange({ target: { value: "Fix it" } });
  await view.all().find(n => n.type === "form")!.props.onSubmit({ preventDefault() {} }); await tick();
  expect(create).toHaveBeenCalledWith("/p/shared", "Fix it");
});

it("a null host repo falls back to the app default", async () => {
  const view = await harness(createMockApi({}), null);
  const create = vi.spyOn(view.api, "newTask");
  view.button(en("tasks.new")).props.onClick();
  view.all().find(n => n.type === "textarea")!.props.onChange({ target: { value: "Fix it" } });
  await view.all().find(n => n.type === "form")!.props.onSubmit({ preventDefault() {} }); await tick();
  expect(create).toHaveBeenCalledWith((await view.api.tasksContext()).defaultRepo, "Fix it");
});
