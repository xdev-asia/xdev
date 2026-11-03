import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { PtyClient } from "./ptyClient";
import { Terminal } from "./Terminal";
import { resetTerminalSettingsForTests, setTerminalSettings, TERMINAL_DEFAULTS } from "./terminalSettings";

// The first ref is the xterm host; the rest keep their initial value.
const hooks = vi.hoisted(() => ({ refs: 0, focused: 0, store: [] as { current: unknown }[], effects: [] as (() => void | (() => void))[], bell: null as (() => void) | null, fits: 0, select: null as (() => void) | null, selection: "", osc: null as ((d: string) => boolean) | null, options: {} as Record<string, unknown>, listeners: {} as Record<string, (e: unknown) => void> }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => [initial, () => {}],
  // Refs are kept by call order, so a second render of the view sees the first one's.
  useRef: (initial: unknown) => {
    const at = hooks.refs++;
    return (hooks.store[at] ??= {
      current:
        at === 0
          ? {
              clientWidth: 0,
              clientHeight: 0,
              addEventListener: (name: string, cb: (e: unknown) => void) => void (hooks.listeners[name] = cb),
              removeEventListener: (name: string) => void delete hooks.listeners[name],
            }
          : initial,
    });
  },
  useEffect: (effect: () => void | (() => void)) => {
    hooks.effects.push(effect);
  },
  useImperativeHandle: (ref: { current: unknown } | null | undefined, create: () => unknown) => {
    if (ref) ref.current = create();
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
    options: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) {
      this.options = hooks.options = { ...opts };
    }
    parser = {
      registerOscHandler(id: number, cb: (d: string) => boolean) {
        if (id === 52) hooks.osc = cb;
      },
    };
    onSelectionChange(cb: () => void) {
      hooks.select = cb;
    }
    onData() {}
    onResize() {}
    onTitleChange() {}
    onBell(cb: () => void) {
      hooks.bell = cb;
    }
    write() {}
    focus() {
      hooks.focused++;
    }
    getSelection() {
      return hooks.selection;
    }
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() { hooks.fits++; } } }));
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
  hooks.fits = 0;
  hooks.select = null;
  hooks.selection = "";
  hooks.osc = null;
  hooks.options = {};
  hooks.listeners = {};
  resetTerminalSettingsForTests();
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

const clipboard = () => {
  const writeText = vi.fn(async () => {});
  const readText = vi.fn(async () => "pasted");
  vi.stubGlobal("navigator", { clipboard: { writeText, readText } });
  return { writeText, readText };
};

it("builds the xterm options from the stored settings", () => {
  setTerminalSettings({ ...TERMINAL_DEFAULTS, fontSize: 17, scrollback: 42, cursorStyle: "bar", fontWeight: "medium" });
  const { effect } = mount({ api: createMockApi({}), id: "o-1" });
  effect();
  expect(hooks.options).toMatchObject({ fontSize: 17, scrollback: 42, cursorStyle: "bar", fontWeight: "500", cursorBlink: true });
});

it("a store change updates the options and fits again", async () => {
  const { effect } = mount({ api: createMockApi({}), id: "o-2" });
  (hooks.store[0].current as { clientWidth: number }).clientWidth = 800;
  (hooks.store[0].current as { clientHeight: number }).clientHeight = 600;
  const cleanup = effect() as () => void;
  const before = hooks.fits;
  setTerminalSettings({ ...TERMINAL_DEFAULTS, fontSize: 20, lineHeight: 1.4 });
  expect(hooks.options).toMatchObject({ fontSize: 20, lineHeight: 1.4 });
  expect(hooks.fits).toBe(before + 1);
  cleanup();
  // A disposed pane no longer listens.
  setTerminalSettings({ ...TERMINAL_DEFAULTS, fontSize: 24 });
  expect(hooks.options.fontSize).toBe(20);
  await tick();
});

it("copy on select writes the clipboard, and writes nothing when off", () => {
  const { writeText } = clipboard();
  const { effect } = mount({ api: createMockApi({}), id: "c-1" });
  effect();
  hooks.selection = "abc";
  hooks.select?.();
  expect(writeText).toHaveBeenCalledWith("abc");
  setTerminalSettings({ ...TERMINAL_DEFAULTS, copyOnSelect: false });
  hooks.select?.();
  expect(writeText).toHaveBeenCalledTimes(1);
});

it("a right click pastes when on and does nothing when off", async () => {
  const { readText } = clipboard();
  const api = createMockApi({});
  const input = vi.spyOn(api, "ptyWrite");
  const { effect } = mount({ api, id: "r-1" });
  effect();
  await tick();
  const event = { preventDefault: vi.fn() };
  setTerminalSettings({ ...TERMINAL_DEFAULTS, rightClickPaste: true });
  hooks.listeners.contextmenu(event);
  await tick();
  expect(event.preventDefault).toHaveBeenCalledTimes(1);
  expect(readText).toHaveBeenCalledTimes(1);
  expect(input).toHaveBeenCalledWith("r-1", new TextEncoder().encode("pasted"));
  setTerminalSettings({ ...TERMINAL_DEFAULTS, rightClickPaste: false });
  hooks.listeners.contextmenu(event);
  await tick();
  expect(event.preventDefault).toHaveBeenCalledTimes(1);
  expect(readText).toHaveBeenCalledTimes(1);
});

it("R1: Shift+right-click opens the menu when paste is on; a right click opens it when paste is off", async () => {
  const { readText } = clipboard();
  const onMenu = vi.fn();
  const handleRef = { current: null as unknown };
  const { effect } = mount({ api: createMockApi({}), id: "m-1", onMenu, handleRef: handleRef as never });
  effect();
  await tick();
  const event = (shiftKey: boolean) => ({ shiftKey, clientX: 12, clientY: 34, preventDefault: vi.fn(), stopPropagation: vi.fn() });
  setTerminalSettings({ ...TERMINAL_DEFAULTS, rightClickPaste: true });
  const shifted = event(true);
  hooks.listeners.contextmenu(shifted);
  await tick();
  expect(shifted.preventDefault).toHaveBeenCalled();
  expect(onMenu).toHaveBeenCalledWith({ x: 12, y: 34 }, handleRef.current);
  expect(readText).not.toHaveBeenCalled();
  setTerminalSettings({ ...TERMINAL_DEFAULTS, rightClickPaste: false });
  hooks.listeners.contextmenu(event(false));
  await tick();
  expect(onMenu).toHaveBeenCalledTimes(2);
  expect(readText).not.toHaveBeenCalled();
});

it("OSC 52 writes the clipboard when on, nothing when off, and never reads", () => {
  const { writeText, readText } = clipboard();
  const { effect } = mount({ api: createMockApi({}), id: "k-1" });
  effect();
  expect(hooks.osc?.("c;aGk=")).toBe(true);
  expect(writeText).toHaveBeenCalledWith("hi");
  expect(hooks.osc?.("c;?")).toBe(true);
  expect(writeText).toHaveBeenCalledTimes(1);
  expect(readText).not.toHaveBeenCalled();
  setTerminalSettings({ ...TERMINAL_DEFAULTS, osc52Clipboard: false });
  expect(hooks.osc?.("c;aGk=")).toBe(true);
  expect(writeText).toHaveBeenCalledTimes(1);
});
