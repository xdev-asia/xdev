import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { createMockApi, type Api } from "@/api";
import { translate } from "@/i18n";
import { AddProjectDialog, parentOf, progressLine } from "./AddProjectDialog";

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
    useRef: (initial: any) => (hooks.active ? state({ current: initial })[0] : react.useRef(initial)),
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
const en = (key: string) => translate("en", key);

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false; });

type CloneApi = Pick<Api, "repoClone" | "repoCloneCancel" | "repoCloneName" | "pickFolder">;

async function view(over: Partial<CloneApi> = {}, startFolder = "/code") {
  const base = createMockApi({});
  const api: CloneApi = { repoClone: base.repoClone, repoCloneCancel: base.repoCloneCancel, repoCloneName: base.repoCloneName, pickFolder: base.pickFolder, ...over };
  const spies = { clone: vi.spyOn(api, "repoClone"), cancel: vi.spyOn(api, "repoCloneCancel"), name: vi.spyOn(api, "repoCloneName") };
  const handlers = { onOpenFolder: vi.fn(), onCloned: vi.fn(), onCancel: vi.fn() };
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return AddProjectDialog({ api, startFolder, ...handlers }); } finally { hooks.active = false; }
  };
  const all = () => nodes(draw());
  const input = (name: string) => all().find((n) => n.type === "input" && n.props.name === name)!;
  const type = async (name: string, value: string) => { input(name).props.onChange({ target: { value } }); await tick(); };
  const press = async (key: string, value: string) => { all().find((n) => n.props[key] === value)!.props.onClick(); await tick(); };
  const submit = async () => { all().find((n) => n.type === "form")!.props.onSubmit({ preventDefault() {} }); await tick(); };
  const clone = () => all().find((n) => n.props.type === "submit")!;
  const text = () => JSON.stringify(draw().props.children);
  draw();
  hooks.effects.forEach((e) => e());
  return { api, spies, handlers, all, input, type, press, submit, clone, text };
}
const toClone = async (v: Awaited<ReturnType<typeof view>>) => { await v.press("data-choice", "clone"); };

it("parentOf gives the folder holding a path", () => {
  expect(parentOf("/code/xdev")).toBe("/code");
  expect(parentOf("/code/xdev/")).toBe("/code");
  expect(parentOf("/xdev")).toBe("/");
  expect(parentOf("C:\\code\\xdev")).toBe("C:\\code");
  expect(parentOf("C:\\xdev")).toBe("C:\\");
  expect(parentOf("xdev")).toBe("");
  expect(parentOf("")).toBe("");
});

it("progressLine shows the phase and a rounded percent when there is one", () => {
  expect(progressLine({ phase: "Receiving objects", percent: 49.6 })).toBe("Receiving objects 50%");
  expect(progressLine({ phase: "Cloning", percent: null })).toBe("Cloning");
});

it("starts with two choices; Open folder hands over to the folder flow", async () => {
  const v = await view();
  expect(v.text()).toContain(en("addProject.openFolder"));
  expect(v.text()).toContain(en("addProject.cloneFromUrl"));
  await v.press("data-choice", "folder");
  expect(v.handlers.onOpenFolder).toHaveBeenCalledOnce();
  expect(v.spies.clone).not.toHaveBeenCalled();
});

it("Clone from URL shows the form with the folder prefilled", async () => {
  const v = await view();
  await toClone(v);
  expect(v.input("folder").props.value).toBe("/code");
  expect(v.input("url").props.value).toBe("");
  expect(v.clone().props.disabled).toBe(true);
});

it("typing a URL fills Name; an edited Name stays", async () => {
  const v = await view();
  await toClone(v);
  await v.type("url", "https://github.com/acme/widgets.git");
  expect(v.spies.name).toHaveBeenCalledWith("https://github.com/acme/widgets.git");
  expect(v.input("name").props.value).toBe("widgets");
  await v.type("name", "mine");
  await v.type("url", "https://github.com/acme/gadgets.git");
  expect(v.input("name").props.value).toBe("mine");
});

it("a URL with no name leaves Name empty and Clone disabled", async () => {
  const v = await view();
  await toClone(v);
  await v.type("url", "https://github.com/acme/widgets.git");
  await v.type("url", "/");
  expect(v.input("name").props.value).toBe("");
  expect(v.clone().props.disabled).toBe(true);
});

it("Choose… fills the folder from the picker and keeps it when the picker is cancelled", async () => {
  const pickFolder = vi.fn().mockResolvedValueOnce("/work").mockResolvedValueOnce(null);
  const v = await view({ pickFolder });
  await toClone(v);
  await v.press("data-act", "choose");
  expect(v.input("folder").props.value).toBe("/work");
  await v.press("data-act", "choose");
  expect(v.input("folder").props.value).toBe("/work");
});

it("Clone sends the trimmed URL, folder and name, shows progress, and hands over the repo on done", async () => {
  const v = await view();
  await toClone(v);
  await v.type("url", " https://github.com/acme/widgets.git ");
  await v.submit();
  expect(v.spies.clone).toHaveBeenCalledOnce();
  const [url, parent, name, id] = v.spies.clone.mock.calls[0];
  expect([url, parent, name]).toEqual(["https://github.com/acme/widgets.git", "/code", "widgets"]);
  expect(id).toMatch(/^clone-/);
  expect(v.handlers.onCloned).toHaveBeenCalledOnce();
  expect(v.handlers.onCloned.mock.calls[0][0].path).toBe("/code/widgets");
});

it("progress events update the line", async () => {
  let emit!: (e: any) => void;
  let finish!: () => void;
  const repoClone = vi.fn((_u: string, _p: string, _n: string | null, _id: string, onEvent: (e: any) => void) => {
    emit = onEvent;
    return new Promise<void>((resolve) => { finish = resolve; });
  });
  const v = await view({ repoClone: repoClone as unknown as Api["repoClone"] });
  await toClone(v);
  await v.type("url", "https://x.test/a/b.git");
  const pending = v.submit();
  await tick();
  emit({ type: "phase", phase: "Receiving objects", percent: 40 });
  expect(v.all().find((n) => n.props["data-progress"])?.props.children).toBe("Receiving objects 40%");
  emit({ type: "phase", phase: "Resolving deltas", percent: null });
  expect(v.all().find((n) => n.props["data-progress"])?.props.children).toBe("Resolving deltas");
  expect(v.clone().props.disabled).toBe(true);
  finish();
  await pending;
});

it("an error shows its message and keeps the form with what was typed", async () => {
  const repoClone = vi.fn(async (_u: string, _p: string, _n: string | null, _id: string, onEvent: (e: any) => void) => {
    onEvent({ type: "error", message: "fatal: repository not found" });
    throw { code: "git_failed" };
  });
  const v = await view({ repoClone: repoClone as unknown as Api["repoClone"] });
  await toClone(v);
  await v.type("url", "https://x.test/a/b.git");
  await v.submit();
  expect(v.all().find((n) => n.props.role === "alert")?.props.children).toBe("fatal: repository not found");
  expect(v.input("url").props.value).toBe("https://x.test/a/b.git");
  expect(v.input("name").props.value).toBe("b");
  expect(v.clone().props.disabled).toBe(false);
  expect(v.handlers.onCloned).not.toHaveBeenCalled();
});

it("a rejection without a message event shows the error code's text", async () => {
  const repoClone = vi.fn(async () => { throw { code: "bad_arg" }; });
  const v = await view({ repoClone: repoClone as unknown as Api["repoClone"] });
  await toClone(v);
  await v.type("url", "https://x.test/a/b.git");
  await v.submit();
  expect(v.all().find((n) => n.props.role === "alert")?.props.children).toBe(translate("en", "error.bad_arg"));
});

it("Cancel during a clone calls repoCloneCancel with the run's id and returns to the form without an error", async () => {
  let reject!: (e: unknown) => void;
  const repoClone = vi.fn(() => new Promise<void>((_, r) => { reject = r; }));
  const v = await view({ repoClone: repoClone as unknown as Api["repoClone"] });
  await toClone(v);
  await v.type("url", "https://x.test/a/b.git");
  const pending = v.submit();
  await tick();
  await v.press("data-act", "cancel");
  expect(v.spies.cancel).toHaveBeenCalledWith((repoClone.mock.calls[0] as unknown[])[3]);
  expect(v.handlers.onCancel).not.toHaveBeenCalled();
  reject({ code: "cancelled" });
  await pending;
  await tick();
  expect(v.all().some((n) => n.props.role === "alert")).toBe(false);
  expect(v.clone().props.disabled).toBe(false);
  // With nothing running, Cancel closes the dialog.
  await v.press("data-act", "cancel");
  expect(v.handlers.onCancel).toHaveBeenCalledOnce();
});
