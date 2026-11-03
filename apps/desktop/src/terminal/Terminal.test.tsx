import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { PtyClient } from "./ptyClient";
import { Terminal } from "./Terminal";

// The first ref is the xterm host; the rest keep their initial value.
const hooks = vi.hoisted(() => ({ refs: 0, effects: [] as (() => void | (() => void))[], bell: null as (() => void) | null }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => [initial, () => {}],
  useRef: (initial: unknown) => ({ current: hooks.refs++ === 0 ? { clientWidth: 0, clientHeight: 0 } : initial }),
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
    onTitleChange() {}
    onBell(cb: () => void) {
      hooks.bell = cb;
    }
    write() {}
    focus() {}
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

function mount(props: Partial<Parameters<typeof Terminal>[0]> & { api: Parameters<typeof Terminal>[0]["api"] }) {
  hooks.refs = 0;
  const onStarted = vi.fn();
  const onError = vi.fn();
  Terminal({ id: "t-1", cwd: "/demo/wt/xdev-oak", profile: "shell", onStarted, onError, ...props });
  const effect = hooks.effects[hooks.effects.length - 1];
  return { effect, onStarted, onError };
}

beforeEach(() => {
  hooks.refs = 0;
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

it("passes the terminal bell on", async () => {
  const api = createMockApi({});
  const onBell = vi.fn();
  const { effect } = mount({ api, id: "bell-1", onBell });
  const cleanup = effect() as () => void;
  hooks.bell?.();
  expect(onBell).toHaveBeenCalledTimes(1);
  cleanup();
  await tick();
});
