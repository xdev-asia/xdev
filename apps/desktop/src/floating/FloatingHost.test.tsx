import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { createMockApi } from "@/mockApi";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as (() => void)[], deps: [] as (unknown[] | undefined)[], effectCursor: 0, cleanups: [] as (() => void)[] }));
const st = vi.hoisted(() => ({ open: false }));
const keys = vi.hoisted(() => ({ handlers: {} as Record<string, unknown>, opts: undefined as unknown }));
const toggle = vi.hoisted(() => vi.fn());
const persist = vi.hoisted(() => ({ load: vi.fn(async (_api: unknown) => {}), stop: vi.fn(), start: vi.fn(), order: [] as string[] }));

vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = initial;
      return [hooks.values[index], (v: unknown) => { hooks.values[index] = v; }];
    },
    // Like React: an effect runs again only when its deps changed, and its cleanup is kept.
    useEffect: (effect: () => unknown, deps?: unknown[]) => {
      const index = hooks.effectCursor++;
      const last = hooks.deps[index];
      if (deps && last && deps.length === last.length && deps.every((d, i) => Object.is(d, last[i]))) return;
      hooks.deps[index] = deps;
      hooks.effects.push(() => {
        const out = effect();
        if (typeof out === "function") hooks.cleanups.push(out as () => void);
      });
    },
  };
});
vi.mock("@/keys/keymap", async (original) => ({
  ...await original<typeof import("@/keys/keymap")>(),
  useKeymap: (h: Record<string, unknown>, o?: unknown) => { keys.handlers = h; keys.opts = o; },
}));
vi.mock("./floatingStore", () => ({ useFloating: () => ({ open: st.open, tabs: [], active: null }), toggleFloating: toggle }));
vi.mock("./FloatingPanel", () => ({ FloatingPanel: () => null }));
vi.mock("./floatingPersist", () => ({
  loadFloating: (api: unknown) => {
    persist.order.push("load");
    return persist.load(api);
  },
  startFloatingSave: (api: unknown) => {
    persist.order.push("start");
    persist.start(api);
    return { flush: async () => {}, stop: persist.stop };
  },
}));

import { FloatingHost } from "./FloatingHost";
import { FloatingPanel } from "./FloatingPanel";

const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const api = createMockApi({});
const draw = async () => {
  hooks.cursor = 0;
  hooks.effectCursor = 0;
  const out = FloatingHost({ api }) as ReactElement<Record<string, unknown>> | null;
  hooks.effects.splice(0).forEach((e) => e());
  await tick();
  return out;
};

beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
  hooks.effects = [];
  hooks.deps = [];
  hooks.effectCursor = 0;
  hooks.cleanups = [];
  persist.load.mockClear();
  persist.start.mockClear();
  persist.stop.mockClear();
  persist.order = [];
  st.open = false;
  keys.handlers = {};
  keys.opts = undefined;
});

it("renders nothing until the first open, then stays after a close", async () => {
  expect(await draw()).toBeNull();
  st.open = true;
  expect((await draw())!.type).toBe(FloatingPanel);
  st.open = false;
  expect((await draw())!.type).toBe(FloatingPanel);
});

it("registers the toggle key with no when", async () => {
  await draw();
  expect(keys.handlers["floating.toggle"]).toBe(toggle);
  expect(keys.opts).toBeUndefined();
});

it("asks for the home folder once, on the first open, and passes it down", async () => {
  const spy = vi.spyOn(api, "homeDir");
  await draw();
  expect(spy).not.toHaveBeenCalled();
  st.open = true;
  await draw();
  st.open = false;
  await draw();
  st.open = true;
  const out = await draw();
  expect(spy).toHaveBeenCalledTimes(1);
  expect(out!.props.home).toBe("/home/demo");
  expect(out!.props.homeError).toBeNull();
});

it("passes the reason when the home folder cannot be found", async () => {
  vi.spyOn(api, "homeDir").mockRejectedValueOnce(new Error("no home"));
  st.open = true;
  await draw();
  const out = await draw();
  expect(out!.props.home).toBeNull();
  expect(out!.props.homeError).toBe("no home");
});

it("loads the saved tabs once on mount, before any open, and starts the saver after", async () => {
  await draw();
  expect(persist.load).toHaveBeenCalledTimes(1);
  expect(persist.load).toHaveBeenCalledWith(api);
  expect(persist.order).toEqual(["load", "start"]);
  expect(persist.start).toHaveBeenCalledTimes(1);
  st.open = true;
  await draw();
  expect(persist.load).toHaveBeenCalledTimes(1);
  expect(persist.start).toHaveBeenCalledTimes(1);
});

it("stops the saver on unmount, and does not start one after an unmount before the load ended", async () => {
  await draw();
  hooks.cleanups.splice(0).forEach((c) => c());
  expect(persist.stop).toHaveBeenCalledTimes(1);
  let release: () => void = () => {};
  persist.load.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
  hooks.deps = [];
  hooks.effectCursor = 0;
  persist.start.mockClear();
  await draw();
  hooks.cleanups.splice(0).forEach((c) => c());
  release();
  await tick();
  expect(persist.start).not.toHaveBeenCalled();
});
