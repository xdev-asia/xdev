import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { PtyClient } from "./ptyClient";
import { Terminal } from "./Terminal";

// The first ref is the xterm host; the rest keep their initial value.
const hooks = vi.hoisted(() => ({ refs: 0, focused: 0, store: [] as { current: unknown }[], effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => [initial, () => {}],
  // Refs are kept by call order, so a second render of the view sees the first one's.
  useRef: (initial: unknown) => {
    const at = hooks.refs++;
    return (hooks.store[at] ??= { current: at === 0 ? { clientWidth: 0, clientHeight: 0 } : initial });
  },
  useEffect: (effect: () => void | (() => void)) => {
    hooks.effects.push(effect);
  },
}));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));
// xterm needs a real canvas; a stand-in with the calls the view makes.
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    onSelectionChange() {}
    onData() {}
    onResize() {}
    write() {}
    focus() {
      hooks.focused++;
    }
    getSelection() {
      return "";
    }
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class { findNext() {} findPrevious() {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

type Props = Parameters<typeof Terminal>[0];

function mount(props: Partial<Props> & { api: Props["api"] }) {
  hooks.refs = 0;
  hooks.store = [];
  const onStarted = vi.fn();
  const onError = vi.fn();
  const full = { id: "t-1", cwd: "/demo/wt/xdev-oak", profile: "shell" as const, onStarted, onError, ...props };
  Terminal(full);
  const effect = hooks.effects[hooks.effects.length - 1];
  // Same view, new props: the effects of that render, the focus one first.
  const render = (next: Partial<Props>) => {
    hooks.refs = 0;
    const before = hooks.effects.length;
    Terminal({ ...full, ...next });
    return hooks.effects[before];
  };
  return { effect, onStarted, onError, render };
}

beforeEach(() => {
  hooks.refs = 0;
  hooks.store = [];
  hooks.focused = 0;
  hooks.effects = [];
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("starts the given client and leaves its pty alive on unmount", async () => {
  const api = createMockApi({});
  const spawn = vi.spyOn(api, "ptySpawn");
  const kill = vi.spyOn(api, "ptyKill");
  const client = new PtyClient(api, "tab-1");
  const { effect, onStarted } = mount({ api, id: "tab-1", client });
  const cleanup = effect() as () => void;
  await tick();
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(spawn.mock.calls[0].slice(0, 3)).toEqual(["tab-1", "/demo/wt/xdev-oak", "shell"]);
  expect(onStarted).toHaveBeenCalled();
  cleanup();
  await tick();
  expect(kill).not.toHaveBeenCalled();
});

it("a mount that is undone at once never starts a shared client", async () => {
  const api = createMockApi({});
  const spawn = vi.spyOn(api, "ptySpawn");
  const client = new PtyClient(api, "tab-2");
  const { effect, onError } = mount({ api, id: "tab-2", client });
  // StrictMode in dev: mount, unmount, mount again with the same client.
  (effect() as () => void)();
  effect();
  await tick();
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(onError).not.toHaveBeenCalled();
});

it("without a client it owns one and kills its pty on unmount", async () => {
  const api = createMockApi({});
  const spawn = vi.spyOn(api, "ptySpawn");
  const kill = vi.spyOn(api, "ptyKill");
  const { effect } = mount({ api, id: "own-1" });
  const cleanup = effect() as () => void;
  await tick();
  expect(spawn.mock.calls[0][0]).toBe("own-1");
  cleanup();
  await tick();
  expect(kill).toHaveBeenCalledWith("own-1");
});

it("takes keyboard focus when focusSeq changes, not on the first value", async () => {
  const api = createMockApi({});
  const { effect, render } = mount({ api, id: "f-1", focusSeq: 1 });
  effect();
  await tick();
  const started = hooks.focused;
  // The first value alone asks nothing.
  render({ focusSeq: 1 })();
  expect(hooks.focused).toBe(started);
  render({ focusSeq: 2 })();
  expect(hooks.focused).toBe(started + 1);
  // The same value again does not focus twice.
  render({ focusSeq: 2 })();
  expect(hooks.focused).toBe(started + 1);
});

it("does not focus when the request is dropped or no xterm is up", async () => {
  const api = createMockApi({});
  const { render } = mount({ api, id: "f-2", focusSeq: 1 });
  // The pty effect has not run: no xterm to focus.
  render({ focusSeq: 2 })();
  expect(hooks.focused).toBe(0);
  render({ focusSeq: undefined })();
  expect(hooks.focused).toBe(0);
});
