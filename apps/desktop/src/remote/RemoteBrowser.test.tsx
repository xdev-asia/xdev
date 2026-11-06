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
import { RemoteBrowser } from "./RemoteBrowser";

async function view(over: Partial<Pick<Api, "remoteBrowse">> = {}) {
  const base = createMockApi({});
  const api = { remoteBrowse: base.remoteBrowse, ...over };
  const browse = vi.spyOn(api, "remoteBrowse");
  const onPath = vi.fn();
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return RemoteBrowser({ api, hostId: "devbox", host: "devbox", onPath }); } finally { hooks.active = false; }
  };
  const all = () => nodes(draw());
  draw();
  hooks.effects.forEach((e) => e());
  await tick();
  const rows = () => all().filter((n) => typeof n.props.title === "string" && typeof n.props.onClick === "function");
  const up = () => all().find((n) => n.props.children === "Up")!;
  const path = () => all().find((n) => n.props["data-testid"] === "remote-path")!.props.children;
  return { browse, onPath, all, rows, up, path };
}

it("starts in the home folder and reports it", async () => {
  const v = await view();
  expect(v.browse).toHaveBeenCalledWith("devbox", undefined);
  expect(v.path()).toBe("/home/dev");
  expect(v.onPath).toHaveBeenLastCalledWith("/home/dev");
  expect(v.rows().map((r) => r.props.title)).toContain("app");
});

it("opens a folder on click and goes Up to its parent", async () => {
  const v = await view();
  v.rows().find((r) => r.props.title === "app")!.props.onClick();
  await tick();
  expect(v.browse).toHaveBeenLastCalledWith("devbox", "/home/dev/app");
  expect(v.path()).toBe("/home/dev/app");
  expect(v.onPath).toHaveBeenLastCalledWith("/home/dev/app");
  expect(v.up().props.disabled).toBe(false);
  v.up().props.onClick();
  await tick();
  expect(v.path()).toBe("/home/dev");
});

it("says why a listing failed, in the host's words", async () => {
  const v = await view({ remoteBrowse: () => Promise.reject({ code: "remote_auth" }) });
  const alert = v.all().find((n) => n.props.role === "alert")!;
  expect(alert.props.children).toBe(translate("en", "remote.error.remote_auth", { host: "devbox" }));
  expect(String(alert.props.children)).toMatch(/key or an agent/);
  expect(v.onPath).not.toHaveBeenCalledWith(expect.stringContaining("/"));
});

it("drops a slow listing that a newer one replaced", async () => {
  let release!: (v: Awaited<ReturnType<Api["remoteBrowse"]>>) => void;
  const base = createMockApi({});
  const slow = new Promise<Awaited<ReturnType<Api["remoteBrowse"]>>>((r) => (release = r));
  let n = 0;
  const v = await view({ remoteBrowse: (h, p) => (n++ === 0 ? slow : base.remoteBrowse(h, p ?? "/home")) });
  hooks.effects.forEach((e) => e());
  await tick();
  release({ path: "/stale", parent: null, dirs: [], truncated: false });
  await tick();
  expect(v.path()).not.toBe("/stale");
});
