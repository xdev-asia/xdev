import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { createMockApi } from "@/mockApi";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
const st = vi.hoisted(() => ({ open: false }));
const keys = vi.hoisted(() => ({ handlers: {} as Record<string, unknown>, opts: undefined as unknown }));
const toggle = vi.hoisted(() => vi.fn());

vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = initial;
      return [hooks.values[index], (v: unknown) => { hooks.values[index] = v; }];
    },
    useEffect: (effect: () => void) => void hooks.effects.push(effect),
  };
});
vi.mock("@/keys/keymap", async (original) => ({
  ...await original<typeof import("@/keys/keymap")>(),
  useKeymap: (h: Record<string, unknown>, o?: unknown) => { keys.handlers = h; keys.opts = o; },
}));
vi.mock("./floatingStore", () => ({ useFloating: () => ({ open: st.open, tabs: [], active: null }), toggleFloating: toggle }));
vi.mock("./FloatingPanel", () => ({ FloatingPanel: () => null }));

import { FloatingHost } from "./FloatingHost";
import { FloatingPanel } from "./FloatingPanel";

const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const api = createMockApi({});
const draw = async () => {
  hooks.cursor = 0;
  const out = FloatingHost({ api }) as ReactElement<Record<string, unknown>> | null;
  hooks.effects.splice(0).forEach((e) => e());
  await tick();
  return out;
};

beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
  hooks.effects = [];
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
