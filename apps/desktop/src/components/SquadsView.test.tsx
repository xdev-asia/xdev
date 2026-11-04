import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { ConfirmDialog } from "./ConfirmDialog";
import { contextPercent, ringLevel, SquadsView } from "./SquadsView";

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
const submit = { preventDefault() {} };
// The view's effects in order: the list, the open squad, accounts, polling.
const EFFECTS = 4;

async function harness(api = createMockApi({}), defaultRepo?: string | null) {
  const draw = () => { hooks.cursor = 0; return SquadsView({ api, defaultRepo, onOpenTask: () => {} }); };
  const html = () => renderToStaticMarkup(draw());
  const all = () => nodes(draw());
  const button = (text: string) => all().find(n => n.props.children === text && n.props.onClick)!;
  const effects = () => { draw(); return hooks.effects.slice(-EFFECTS); };
  const reload = async () => { const [list, squad] = effects(); list(); squad(); await tick(); };
  const [list, , accounts] = effects();
  list(); accounts(); await tick();
  await reload();
  const open = async (name: string) => {
    all().find(n => n.props.className === "task-item" && nodes(n.props.children).some(c => c.props.children === name))!.props.onClick();
    await reload();
  };
  const seat = (role: string) => all().find(n => n.props.className === "squad-seat" && n.props["data-role"] === role)!;
  return { api, draw, html, all, button, reload, open, seat };
}
beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; });

it("colours the ring by how much context is used", () => {
  expect([0, 69, 70, 89, 90, 100].map(ringLevel)).toEqual(["accent", "accent", "warn", "warn", "danger", "danger"]);
  expect(contextPercent(undefined)).toBeNull();
  expect(contextPercent({ state: "idle", session: null, context: null, last: "", wait: null, queued: [] })).toBeNull();
  expect(contextPercent({ state: "idle", session: null, context: { used: 180_000, window: 200_000 }, last: "", wait: null, queued: [] })).toBe(90);
});

it("lists squads with a state chip and shows the seat tree of a running squad", async () => {
  const view = await harness();
  let html = view.html();
  for (const name of ["Bug squad", "Feature squad", "Docs squad", "Release squad"]) expect(html).toContain(name);
  for (const state of ["idle", "running", "waiting", "done"]) expect(html).toContain(`data-state="${state}"`);
  expect(html).toContain(en("tasks.goal"));

  await view.open("Feature squad");
  html = view.html();
  expect(html).toMatch(/hierarchy · [^·<]+ · started 25 min ago/);
  expect(html).toContain(en("squads.active", { count: 1 }));
  expect(html).toContain(en("squads.vacantCount", { count: 1 }));
  expect(html).toContain("1 violation<");
  expect(html).toContain(en("squads.stop"));
  expect(html).not.toContain(`aria-label="${en("tasks.goal")}"`);

  const order = ["lead", "implement", "review", "tests"].map(r => html.indexOf(`data-role="${r}"`));
  expect(order).toEqual([...order].sort((a, b) => a - b));
  const seatHtml = (role: string) => renderToStaticMarkup(view.seat(role));
  // Implement uses 150k of 200k tokens, the lead 64k; tests is vacant.
  expect(seatHtml("implement")).toContain('data-level="warn"');
  expect(seatHtml("implement")).toContain(">X<");
  expect(seatHtml("implement")).toContain("Codex · 75%");
  expect(seatHtml("lead")).toContain('data-level="accent"');
  expect(seatHtml("lead")).toContain(">C<");
  expect(seatHtml("tests")).not.toContain("data-level");
  expect(seatHtml("tests")).toContain(en("squads.seat.vacant"));
  expect(seatHtml("review")).not.toContain("squad-ring-used");
});

it("answers the question put to the person", async () => {
  const view = await harness();
  await view.open("Docs squad");
  const html = view.html();
  expect(html).toContain(en("squads.escalationsCount", { count: 1 }));
  expect(html).toContain("Implement → You");
  expect(html).toContain("Which folder should the page go in");
  expect(html).toContain("12 min ago");
  expect(renderToStaticMarkup(view.seat("implement"))).toContain(en("squads.seat.needs_you"));

  const answer = vi.spyOn(view.api, "answerSquad");
  view.all().find(n => n.props.className === "squad-answer")!.props.onChange({ target: { value: "docs/" } });
  await view.all().find(n => n.type === "form" && nodes(n.props.children).some(c => c.props.className === "squad-answer"))!.props.onSubmit(submit);
  await tick();
  expect(answer).toHaveBeenCalledWith("20261102-0800-docs-squad", "e1", "docs/");
  await view.reload();
  const after = view.html();
  expect(after).toContain(en("squads.answered", { answer: "docs/" }));
  expect(after).not.toContain("squad-answer");
  expect(after).toContain(en("squads.escalationsCount", { count: 0 }));
});

it("steers a seat from its side sheet", async () => {
  const view = await harness();
  await view.open("Feature squad");
  view.seat("implement").props.onClick();
  const sheet = () => view.all().find(n => n.props.className === "squad-sheet")!;
  const text = renderToStaticMarkup(sheet());
  expect(text).toContain("codex-1 · Codex");
  expect(text).toContain("Editing src/retry.ts");
  expect(text).toContain(en("squads.changeAccount"));

  const steer = vi.spyOn(view.api, "steerSquad");
  nodes(sheet()).find(n => n.type === "textarea")!.props.onChange({ target: { value: "Keep the API" } });
  await nodes(sheet()).find(n => n.type === "form")!.props.onSubmit(submit);
  await tick();
  expect(steer).toHaveBeenCalledWith("20261102-1000-feature-squad", "implement", "Keep the API");
  await view.reload();
  expect(renderToStaticMarkup(sheet())).toContain(en("squads.queued", { count: 1 }).replace("'", "&#x27;"));
  // The account cannot change while the squad runs.
  expect(nodes(sheet()).find(n => n.type === "select")!.props.disabled).toBe(true);
});

it("asks before deactivating and stops only once confirmed", async () => {
  const view = await harness();
  await view.open("Feature squad");
  const stop = vi.spyOn(view.api, "stopSquad");
  view.button(en("squads.stop")).props.onClick();
  let dialog = view.all().find(n => n.type === ConfirmDialog)!;
  expect(dialog.props.open).toBe(true);
  expect(dialog.props.confirmLabel).toBe(en("squads.stop"));
  dialog.props.onCancel();
  expect(view.all().find(n => n.type === ConfirmDialog)!.props.open).toBe(false);
  expect(stop).not.toHaveBeenCalled();

  view.button(en("squads.stop")).props.onClick();
  dialog = view.all().find(n => n.type === ConfirmDialog)!;
  dialog.props.onConfirm(); await tick();
  expect(stop).toHaveBeenCalledWith("20261102-1000-feature-squad");
  await view.reload();
  const html = view.html();
  expect(html).toContain(en("tasks.resume"));
  expect(html).not.toContain("squad-stop");
  expect(view.all().find(n => n.type === ConfirmDialog)!.props.open).toBe(false);
});

it("runs a goal, shows it running while the call is out, and links to its task", async () => {
  vi.useFakeTimers();
  try {
    const api = createMockApi({}, { runDelayMs: 1000 });
    const opened: string[] = [];
    const view = await harness(api);
    view.all().find(n => n.type === "input" && n.props["aria-label"] === en("tasks.goal"))!.props.onChange({ target: { value: "Fix the bug" } });
    const done = view.all().find(n => n.type === "form" && n.props.className === "task-row squad-goal-form")!.props.onSubmit(submit);
    await tick();
    await view.reload();
    expect(view.html()).toContain(en("squads.working"));
    await vi.advanceTimersByTimeAsync(1000); await done;
    await view.reload();
    const html = view.html();
    expect(html).not.toContain(en("squads.working"));
    expect(html).toContain(en("squads.event.done"));
    hooks.cursor = 0;
    const link = nodes(SquadsView({ api, onOpenTask: (id) => opened.push(id) })).find(n => n.props.children === en("squads.openTask"))!;
    link.props.onClick();
    expect(opened).toEqual([(await api.squad("20261102-1200-bug-squad")).run!.task]);
  } finally {
    vi.useRealTimers();
  }
});

it("creates a squad with one account per seat", async () => {
  const view = await harness();
  view.button(en("squads.new")).props.onClick();
  const form = () => view.all().find(n => n.type === "form" && n.props["aria-label"] === en("squads.new"))!;
  const html = renderToStaticMarkup(form());
  expect(html).toContain("codex-1 · Codex · ");
  expect(html.match(/<select/g)).toHaveLength(4);
  const inputs = () => nodes(form()).filter(n => n.type === "input");
  inputs()[0].props.onChange({ target: { value: "New team" } });
  nodes(form()).filter(n => n.type === "select")[1].props.onChange({ target: { value: "claude-2" } });
  const create = vi.spyOn(view.api, "newSquad");
  await form().props.onSubmit(submit); await tick();
  expect(create).toHaveBeenCalledWith("New team", expect.any(String), [
    { role: "lead", account: null },
    { role: "implement", account: "claude-2" },
    { role: "tests", account: null },
    { role: "review", account: null },
  ], null);
  await view.reload();
  expect(view.html()).toContain("New team");
});

it.each([["/p/shared", "/p/shared"], [null, null]] as const)("a new squad goes to the host repo %s, else the app default", async (host, expected) => {
  const view = await harness(createMockApi({}), host);
  view.button(en("squads.new")).props.onClick();
  const form = () => view.all().find(n => n.type === "form" && n.props["aria-label"] === en("squads.new"))!;
  nodes(form()).filter(n => n.type === "input")[0].props.onChange({ target: { value: "Team" } });
  const create = vi.spyOn(view.api, "newSquad");
  await form().props.onSubmit(submit); await tick();
  expect(create).toHaveBeenCalledWith("Team", expected ?? (await view.api.tasksContext()).defaultRepo, expect.any(Array), null);
});
