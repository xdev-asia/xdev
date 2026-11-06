import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { translate } from "@/i18n";

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
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false; });
import { createMockApi, type Api } from "@/api";
import { AddRemoteFolder } from "./AddRemoteFolder";

type A = Pick<Api, "remoteHostsState" | "remoteBrowse" | "remoteProjectAdd">;

async function view(over: Partial<A> = {}) {
  const base = createMockApi({});
  const api: A = { remoteHostsState: base.remoteHostsState, remoteBrowse: base.remoteBrowse, remoteProjectAdd: base.remoteProjectAdd, ...over };
  const add = vi.spyOn(api, "remoteProjectAdd");
  const handlers = { onAdded: vi.fn(), onBack: vi.fn(), onOpenSettings: vi.fn() };
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return AddRemoteFolder({ api, ...handlers }); } finally { hooks.active = false; }
  };
  const all = () => nodes(draw());
  draw();
  hooks.effects.forEach((e) => e());
  await tick();
  const browsed = (path: string) => all().find((n) => typeof n.props.onPath === "function")!.props.onPath(path);
  const submit = async () => { all().find((n) => n.type === "form")!.props.onSubmit({ preventDefault() {} }); await tick(); };
  const open = () => all().find((n) => n.props.type === "submit")!;
  const name = () => all().find((n) => n.props.name === "name" && "value" in n.props)!;
  return { add, handlers, all, browsed, submit, open, name };
}

it("names the project after the last folder segment and adds it on submit", async () => {
  const v = await view();
  expect(v.open().props.disabled).toBe(true);
  v.browsed("/home/dev/app");
  await tick();
  expect(v.name().props.value).toBe("app");
  expect(v.open().props.disabled).toBe(false);
  expect(v.open().props.children).toBe("Open folder");
  await v.submit();
  expect(v.add).toHaveBeenCalledWith("devbox", "/home/dev/app", "app");
  expect(v.handlers.onAdded).toHaveBeenCalledWith(expect.objectContaining({ hostId: "devbox", name: "app", worktree: "ssh://devbox/home/dev/app" }));
});

it("keeps a name the person typed when the folder changes", async () => {
  const v = await view();
  v.browsed("/home/dev/app");
  await tick();
  v.name().props.onChange({ target: { value: "work" } });
  await tick();
  v.browsed("/home/dev");
  await tick();
  expect(v.name().props.value).toBe("work");
  await v.submit();
  expect(v.add).toHaveBeenCalledWith("devbox", "/home/dev", "work");
});

it("shows a refusal with the host's wording and stays open", async () => {
  const v = await view({ remoteProjectAdd: () => Promise.reject({ code: "remote_path" }) });
  v.browsed("/nope");
  await tick();
  await v.submit();
  expect(v.handlers.onAdded).not.toHaveBeenCalled();
  expect(v.all().find((n) => n.props.role === "alert")!.props.children).toBe(translate("en", "remote.error.remote_path", { host: "devbox" }));
});

it("with no host offers Add an SSH host, which opens Settings", async () => {
  const v = await view({ remoteHostsState: async () => [] });
  const empty = v.all().find((n) => n.props.title === "Add an SSH host")!;
  expect(empty).toBeTruthy();
  const button = nodes(empty.props.actions).find((n) => n.props.children === "Add an SSH host")!;
  button.props.onClick();
  expect(v.handlers.onOpenSettings).toHaveBeenCalled();
  expect(v.all().some((n) => n.type === "form")).toBe(false);
});
