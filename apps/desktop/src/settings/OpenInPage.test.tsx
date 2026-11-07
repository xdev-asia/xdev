import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Select } from "@xdev-asia/ui";
import { createMockApi, type OpenInApp } from "@/api";
import { translate } from "@/i18n";
import { DEFAULT_APPS, foundByCommand, MAX_APPS, move, nextId, OPEN_AS_CHOICES, OpenInPage } from "./OpenInPage";

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
    useRef: (initial: any) => {
      if (!hooks.active) return react.useRef(initial);
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = { current: initial };
      return hooks.values[index];
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

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false; });

async function view(initial?: OpenInApp[], registerSave?: (spec: unknown) => void) {
  const api = createMockApi({});
  if (initial) await api.openInSettingsPut({ apps: initial });
  const onChanged = vi.fn();
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return OpenInPage({ api, onChanged, registerSave }); } finally { hooks.active = false; }
  };
  draw();
  hooks.effects.forEach((e) => e());
  await tick();
  const all = () => nodes(draw());
  const act = (name: string, app?: string) => {
    const root = app ? all().find((n) => n.props["data-app"] === app)! : draw();
    return nodes(root).find((n) => n.props["data-act"] === name)!;
  };
  const press = async (name: string, app?: string) => { act(name, app).props.onClick(); await tick(); };
  const type = (name: string, value: string) => all().find((n) => (n.type === "input" || n.type === "textarea") && n.props.name === name)!.props.onChange({ target: { value } });
  const submit = async () => { all().find((n) => n.type === "form")!.props.onSubmit({ preventDefault() {} }); await tick(); };
  const stored = async () => (await api.openInSettings()).apps;
  // Runs the effects the last draw queued, as a commit would (the SaveBar spec is handed over in one).
  const settle = () => { hooks.effects.length = 0; draw(); hooks.effects.splice(0).forEach((e) => e()); };
  return { api, onChanged, all, act, press, type, submit, stored, settle };
}

it("move and nextId are plain list helpers", () => {
  expect(move([1, 2, 3], 2, 1)).toEqual([1, 3, 2]);
  expect(move([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
  expect(move([1, 2, 3], 2, 3)).toEqual([1, 2, 3]);
  expect(nextId(DEFAULT_APPS)).toBe("app-1");
  expect(nextId([{ id: "app-1", label: "a", command: "a", args: [] }])).toBe("app-2");
});

it("lists each app with its command and arguments", async () => {
  const v = await view([...DEFAULT_APPS, { id: "app-1", label: "Zed", command: "zed", args: ["--new", "-w"] }]);
  const rows = v.all().filter((n) => n.props["data-app"]);
  expect(rows.map((n) => n.props["data-app"])).toEqual(["vscode", "app-1"]);
  const text = nodes(rows[1]).map((n) => n.props.children).filter((c) => typeof c === "string");
  expect(text).toContain("Zed");
  expect(text).toContain("zed --new -w");
});

it("Add stores a new app with the typed arguments, one per line", async () => {
  const v = await view();
  await v.press("add");
  v.type("label", " Cursor ");
  v.type("command", "cursor");
  v.type("args", "--reuse-window\n\n -n ");
  await v.submit();
  expect(await v.stored()).toEqual([...DEFAULT_APPS, { id: "app-1", label: "Cursor", command: "cursor", args: ["--reuse-window", "-n"] }]);
  expect(v.onChanged).toHaveBeenCalledTimes(1);
  expect(v.all().some((n) => n.type === "form")).toBe(false);
});

it("Edit changes an app in place and keeps its id", async () => {
  const v = await view();
  await v.press("edit", "vscode");
  v.type("label", "Code");
  await v.submit();
  expect(await v.stored()).toEqual([{ id: "vscode", label: "Code", command: "code", args: [] }]);
});

it("bad_arg shows under the field and keeps the form and the typed text", async () => {
  const v = await view();
  await v.press("add");
  v.type("label", "Broken");
  v.type("command", "my tool");
  await v.submit();
  const input = v.all().find((n) => n.type === "input" && n.props.name === "command")!;
  expect(input.props["aria-invalid"]).toBe(true);
  expect(input.props.value).toBe("my tool");
  expect(v.all().find((n) => n.props.id === "openin-command-error")?.props.children).toBe(en("error.bad_arg"));
  expect(await v.stored()).toEqual(DEFAULT_APPS);
  expect(v.onChanged).not.toHaveBeenCalled();
});

it("Move down and Move up reorder and store at once", async () => {
  const w = await view([...DEFAULT_APPS, { id: "app-1", label: "Zed", command: "zed", args: [] }]);
  expect(w.act("up", "vscode").props.disabled).toBe(true);
  await w.press("down", "vscode");
  expect((await w.stored()).map((a) => a.id)).toEqual(["app-1", "vscode"]);
  expect(w.act("down", "vscode").props.disabled).toBe(true);
  await w.press("up", "vscode");
  expect((await w.stored()).map((a) => a.id)).toEqual(["vscode", "app-1"]);
});

it("Delete asks first, then removes the app", async () => {
  const v = await view();
  await v.press("delete", "vscode");
  const dialog = v.all().find((n) => n.props.onConfirm && n.props.onCancel)!;
  expect(dialog.props.title).toBe(en("openIn.delete.title", { name: "VS Code" }));
  expect(await v.stored()).toEqual(DEFAULT_APPS);
  dialog.props.onConfirm();
  await tick();
  expect(await v.stored()).toEqual([]);
  expect(v.all().some((n) => n.props.onConfirm)).toBe(false);
  expect(v.all().some((n) => n.props.children === en("openIn.empty"))).toBe(true);
});

it("Delete then Cancel leaves the list alone", async () => {
  const v = await view();
  await v.press("delete", "vscode");
  v.all().find((n) => n.props.onCancel)!.props.onCancel();
  expect(await v.stored()).toEqual(DEFAULT_APPS);
  expect(v.all().some((n) => n.props.onConfirm)).toBe(false);
});

it("Reset to default restores VS Code alone", async () => {
  const w = await view([{ id: "app-1", label: "Zed", command: "zed", args: [] }]);
  await w.press("reset");
  expect(await w.stored()).toEqual(DEFAULT_APPS);
});

it("Add is disabled at the limit", async () => {
  const w = await view(Array.from({ length: MAX_APPS }, (_, i) => ({ id: `app-${i + 1}`, label: `A${i}`, command: "a", args: [] })));
  expect(w.act("add").props.disabled).toBe(true);
  expect(w.all().some((n) => n.props.children?.[0] === false)).toBe(false);
});

it("Presets lists the four editors; the one in the list shows Added instead of Add", async () => {
  const v = await view();
  const rows = v.all().filter((n) => n.props["data-preset"]);
  expect(rows.map((n) => n.props["data-preset"])).toEqual(["code", "cursor", "zed", "windsurf"]);
  const buttons = (row: (typeof rows)[number]) => nodes(row).filter((n) => n.props["data-act"] === "add-preset");
  expect(buttons(rows[0])).toHaveLength(0);
  expect(nodes(rows[0]).some((n) => n.props.children === en("openIn.preset.added"))).toBe(true);
  expect(buttons(rows[1])).toHaveLength(1);
});

it("Add on a preset stores it through the same save path", async () => {
  const v = await view();
  const row = v.all().find((n) => n.props["data-preset"] === "cursor")!;
  nodes(row).find((n) => n.props["data-act"] === "add-preset")!.props.onClick();
  await tick();
  expect(await v.stored()).toEqual([...DEFAULT_APPS, { id: "cursor", label: "Cursor", command: "cursor", args: [] }]);
  expect(v.onChanged).toHaveBeenCalledTimes(1);
  const after = v.all().find((n) => n.props["data-preset"] === "cursor")!;
  expect(nodes(after).some((n) => n.props["data-act"] === "add-preset")).toBe(false);
});

it("marks each app and preset found or missing, and disables a missing preset", async () => {
  const v = await view([...DEFAULT_APPS, { id: "app-1", label: "Nano", command: "nano", args: [] }]);
  const badge = (app: string) => nodes(v.all().find((n) => n.props["data-app"] === app)!).find((n) => n.props.status)?.props.children;
  expect(badge("vscode")).toBe(en("openIn.found"));
  expect(badge("app-1")).toBe(en("openIn.missing"));
  const reasons = v.all().filter((n) => n.props["data-found"] === "false");
  expect(reasons.map((n) => n.props.children)).toContain(en("openIn.missing.reason"));
  // Presets: Cursor is found, Zed and Windsurf are not.
  const add = (cmd: string) => nodes(v.all().find((n) => n.props["data-preset"] === cmd)!).find((n) => n.props["data-act"] === "add-preset")!;
  expect(add("cursor").props.disabled).toBe(false);
  expect(add("zed").props.disabled).toBe(true);
  expect(add("windsurf").props.disabled).toBe(true);
});

it("foundByCommand keys apps by their command and presets by theirs", () => {
  const apps = [{ id: "a", label: "A", command: " nano ", args: [] }];
  expect(foundByCommand({ apps, found: [{ id: "a", found: false }], presets: [{ id: "code", found: true }] })).toEqual({ nano: false, code: true });
});

it("Open agents as starts at a new tab and stores the choice without touching other Agents settings", async () => {
  const v = await view();
  const select = () => v.all().find((n) => n.type === Select && n.props.name === "openAs")!;
  expect(select().props.value).toBe("tab");
  expect((select().props.options as { value: string }[]).map((o) => o.value)).toEqual(OPEN_AS_CHOICES);
  await v.api.agentsSettingsPut({ ...(await v.api.agentsSettings()), sleepAfterMin: 5 });
  select().props.onChange({ target: { value: "splitRight" } });
  await tick();
  const stored = await v.api.agentsSettings();
  expect(stored.openAs).toBe("splitRight");
  expect(stored.sleepAfterMin).toBe(5);
  expect(v.onChanged).toHaveBeenCalledTimes(1);
  expect(select().props.value).toBe("splitRight");
});

it("in Settings the view's SaveBar stores the edited app and Discard drops it; the form has no buttons of its own", async () => {
  const registerSave = vi.fn();
  const v = await view(undefined, registerSave);
  await v.press("add");
  v.settle();
  expect(registerSave).toHaveBeenLastCalledWith(expect.objectContaining({ dirty: true }));
  const form = v.all().find((n) => n.type === "form")!;
  expect(nodes(form).some((n) => n.props.type === "submit")).toBe(false);
  v.type("label", "Zed");
  v.type("command", "zed");
  v.settle();
  registerSave.mock.calls.at(-1)![0].onSave();
  await tick();
  expect(await v.stored()).toEqual([...DEFAULT_APPS, { id: "app-1", label: "Zed", command: "zed", args: [] }]);
  expect(v.all().some((n) => n.type === "form")).toBe(false);
  v.settle();
  expect(registerSave).toHaveBeenLastCalledWith(expect.objectContaining({ dirty: false }));

  await v.press("add");
  v.settle();
  registerSave.mock.calls.at(-1)![0].onDiscard();
  expect(v.all().some((n) => n.type === "form")).toBe(false);
  expect(await v.stored()).toHaveLength(2);
});
