import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMockApi } from "@/api";
import { setMockClipboardImage } from "@/mockApi";
import { getToasts, resetToastsForTests } from "@/workspace/toastStore";
import { translate } from "@/i18n";
import { resetBindingsForTests, setKeySettings } from "@/keys/bindingsStore";
import { PtyClient } from "./ptyClient";
import { Terminal } from "./Terminal";
import { TERMINAL_SCHEMES } from "./terminalThemes";
import { resetCustomSchemesForTests, setCustomSchemes } from "./customSchemes";
import { resetTerminalSettingsForTests, setTerminalSettings, TERMINAL_DEFAULTS } from "./terminalSettings";

// The first ref is the xterm host; the rest keep their initial value.
const hooks = vi.hoisted(() => ({ refs: 0, focused: 0, store: [] as { current: unknown }[], effects: [] as (() => void | (() => void))[], bell: null as (() => void) | null, fits: 0, select: null as (() => void) | null, selection: "", osc: null as ((d: string) => boolean) | null, options: {} as Record<string, unknown>, keyHandler: null as null | ((e: KeyboardEvent) => boolean), calls: [] as string[], listeners: {} as Record<string, (e: unknown) => void>, pasted: [] as string[], renderer: [] as string[], searchOpts: undefined as unknown, platform: "win" as string, csi: {} as Record<string, (p: unknown[]) => boolean>, bufType: "normal", bracketedMode: true, providers: [] as unknown[], linkHandler: null as null | { activate(e: unknown, text: string, range: unknown): void; allowNonHttpProtocols?: boolean }, webLinks: null as null | { handler: (e: unknown, uri: string) => void; options: { hover?: unknown; leave?: unknown } | undefined } }));
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
              classList: { add() {}, remove() {} },
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
// The platform the pane resolves keys for; a test sets `hooks.platform`.
vi.mock("@/platform", () => ({
  get PLATFORM() {
    return hooks.platform;
  },
  get IS_MAC() {
    return hooks.platform === "mac";
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
    attachCustomKeyEventHandler(cb: (e: KeyboardEvent) => boolean) {
      hooks.keyHandler = cb;
    }
    clear() {
      hooks.calls.push("clear");
    }
    selectAll() {
      hooks.calls.push("selectAll");
    }
    paste(text: string) {
      hooks.calls.push(`paste:${text}`);
      hooks.pasted.push(text);
    }
    options: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) {
      this.options = hooks.options = { ...opts };
      hooks.linkHandler = (opts.linkHandler as typeof hooks.linkHandler) ?? null;
    }
    registerLinkProvider(provider: unknown) {
      hooks.providers.push(provider);
      return { dispose() {} };
    }
    parser = {
      registerOscHandler(id: number, cb: (d: string) => boolean) {
        if (id === 52) hooks.osc = cb;
      },
      registerCsiHandler(id: { prefix?: string; intermediates?: string; final: string }, cb: (p: unknown[]) => boolean) {
        hooks.csi[`${id.prefix ?? ""}${id.intermediates ?? ""}${id.final}`] = cb;
        return { dispose() {} };
      },
      registerEscHandler() {
        return { dispose() {} };
      },
    };
    modes = {
      get bracketedPasteMode() {
        return hooks.bracketedMode;
      },
    };
    buffer = {
      active: {
        length: 0,
        getLine: () => undefined,
        get type() {
          return hooks.bufType;
        },
      },
    };
    scrollToTop() {
      hooks.calls.push("scrollToTop");
    }
    scrollToBottom() {
      hooks.calls.push("scrollToBottom");
    }
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
    hasSelection() {
      return hooks.selection.length > 0;
    }
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() { hooks.fits++; } } }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class { constructor(opts?: unknown) { hooks.searchOpts = opts; } findNext() {} findPrevious() {} } }));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {
    constructor(handler: (e: unknown, uri: string) => void, options?: { hover?: unknown; leave?: unknown }) {
      hooks.webLinks = { handler, options };
    }
  },
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
// The renderer has its own tests; here only what the pane asks of it.
vi.mock("./terminalRenderer", () => ({
  attachRenderer: (_term: unknown, gpu: string) => {
    hooks.renderer.push(`attach:${gpu}`);
    return {
      set: (next: string) => void hooks.renderer.push(`set:${next}`),
      active: () => "dom",
      dispose: () => void hooks.renderer.push("dispose"),
    };
  },
}));

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
  hooks.keyHandler = null;
  hooks.platform = "win";
  hooks.csi = {};
  hooks.bufType = "normal";
  hooks.calls = [];
  resetBindingsForTests();
  hooks.listeners = {};
  hooks.pasted = [];
  hooks.renderer = [];
  hooks.providers = [];
  hooks.linkHandler = null;
  hooks.webLinks = null;
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

it("the stored theme builds the xterm and the pane takes its background", () => {
  const pane = { style: { background: "" }, classList: { add() {}, remove() {} }, addEventListener() {}, removeEventListener() {} };
  setTerminalSettings({ ...TERMINAL_DEFAULTS, theme: "dracula", wordSeparators: " /" });
  const { effect } = mount({ api: createMockApi({}), id: "th-1" });
  (hooks.store[0].current as { parentElement?: unknown }).parentElement = pane;
  effect();
  const dracula = TERMINAL_SCHEMES.find((x) => x.id === "dracula")!;
  expect(hooks.options.theme).toEqual(dracula.colors);
  expect(hooks.options.wordSeparator).toBe(" /");
  expect(pane.style.background).toBe(dracula.colors.background);
  setTerminalSettings({ ...TERMINAL_DEFAULTS, theme: "app" });
  // The app theme: the tokens (empty here), so the pane drops its own background.
  expect(pane.style.background).toBe("");
});

it("the pane attaches the renderer after open, follows the gpu setting and disposes it", () => {
  setTerminalSettings({ ...TERMINAL_DEFAULTS, gpu: "on" });
  const { effect } = mount({ api: createMockApi({}), id: "gpu-1" });
  const cleanup = effect() as () => void;
  expect(hooks.renderer).toEqual(["attach:on"]);
  setTerminalSettings({ ...TERMINAL_DEFAULTS, gpu: "off" });
  expect(hooks.renderer).toEqual(["attach:on", "set:off"]);
  cleanup();
  expect(hooks.renderer.at(-1)).toBe("dispose");
});

it("a store change updates the options and fits again", async () => {
  const { effect } = mount({ api: createMockApi({}), id: "o-2" });
  (hooks.store[0].current as { clientWidth: number }).clientWidth = 800;
  (hooks.store[0].current as { clientHeight: number }).clientHeight = 600;
  const cleanup = effect() as () => void;
  const before = hooks.fits;
  setTerminalSettings({
    ...TERMINAL_DEFAULTS,
    fontSize: 20,
    lineHeight: 1.4,
    theme: "nord",
    wordSeparators: " /",
    scrollSensitivity: 2,
    fastScrollSensitivity: 8,
    minimumContrast: 4.5,
  });
  expect(hooks.options).toMatchObject({
    fontSize: 20,
    lineHeight: 1.4,
    wordSeparator: " /",
    scrollSensitivity: 2,
    fastScrollSensitivity: 8,
    minimumContrastRatio: 4.5,
  });
  expect((hooks.options.theme as { background: string }).background).toBe(
    TERMINAL_SCHEMES.find((x) => x.id === "nord")?.colors.background,
  );
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

it("a right click with an image on the clipboard writes its saved path as a bracketed paste", async () => {
  const readText = vi.fn(async () => "");
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(), readText } });
  setMockClipboardImage("/tmp/xdev-paste.png");
  const api = createMockApi({});
  const input = vi.spyOn(api, "ptyWrite");
  const { effect } = mount({ api, id: "img-1" });
  effect();
  await tick();
  setTerminalSettings({ ...TERMINAL_DEFAULTS, rightClickPaste: true });
  hooks.listeners.contextmenu({ preventDefault: vi.fn() });
  await tick();
  expect(input).toHaveBeenCalledWith("img-1", new TextEncoder().encode("[200~/tmp/xdev-paste.png[201~"));
  setMockClipboardImage(null);
});

it("a right click image paste is a plain quoted word while bracketed paste mode is off", async () => {
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(), readText: vi.fn(async () => "") } });
  setMockClipboardImage("/tmp/xdev-paste.png");
  hooks.bracketedMode = false;
  const api = createMockApi({});
  const input = vi.spyOn(api, "ptyWrite");
  const { effect } = mount({ api, id: "img-2" });
  effect();
  await tick();
  setTerminalSettings({ ...TERMINAL_DEFAULTS, rightClickPaste: true });
  hooks.listeners.contextmenu({ preventDefault: vi.fn() });
  await tick();
  hooks.bracketedMode = true;
  expect(input).toHaveBeenCalledWith("img-2", new TextEncoder().encode("/tmp/xdev-paste.png "));
  setMockClipboardImage(null);
});

it("an image too large, or one that cannot be saved, says so in a toast", async () => {
  resetToastsForTests();
  const readText = vi.fn(async () => "");
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(), readText } });
  const { effect } = mount({ api: createMockApi({}), id: "img-2" });
  effect();
  await tick();
  setTerminalSettings({ ...TERMINAL_DEFAULTS, rightClickPaste: true });
  setMockClipboardImage({ code: "too_large" });
  hooks.listeners.contextmenu({ preventDefault: vi.fn() });
  await tick();
  expect(getToasts().map((x) => x.text)).toEqual([translate("en", "terminal.input.imageTooLarge")]);
  setMockClipboardImage(new Error("io"));
  hooks.listeners.contextmenu({ preventDefault: vi.fn() });
  await tick();
  expect(getToasts().map((x) => x.text)).toContain(translate("en", "terminal.input.imageSaveFailed"));
  setMockClipboardImage(null);
  resetToastsForTests();
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

it("the handle in handleRef copies and pastes through the live xterm", async () => {
  const { writeText } = clipboard();
  const handleRef = { current: null as null | import("./Terminal").TerminalHandle };
  const { effect } = mount({ api: createMockApi({}), id: "h-1", handleRef: handleRef as never });
  const h = handleRef.current!;
  expect(await h.copy()).toBe(false);
  effect();
  await tick();
  hooks.selection = "echo hi";
  expect(await h.copy()).toBe(true);
  expect(writeText).toHaveBeenCalledWith("echo hi");
  await h.paste();
  expect(hooks.pasted).toEqual(["pasted"]);
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

// ---- Keys the app owns ----

const key = (init: Record<string, unknown>) => {
  const e = { type: "keydown", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, code: "", preventDefault: vi.fn(), ...init };
  return e as unknown as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> };
};

function started() {
  const { effect } = mount({ api: createMockApi({}) });
  effect();
  return hooks.keyHandler!;
}

it("Ctrl+K clears the terminal and sends nothing to the program", () => {
  vi.stubGlobal("navigator", { userAgent: "Windows" });
  const handler = started();
  const e = key({ ctrlKey: true, code: "KeyK" });
  expect(handler(e)).toBe(false);
  expect(hooks.calls).toEqual(["clear"]);
  expect(e.preventDefault).toHaveBeenCalled();
});

it("select all and paste run in the terminal; copy writes the selection", async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { userAgent: "Windows", clipboard: { writeText, readText: async () => "pasted" } });
  hooks.selection = "chosen";
  const handler = started();
  expect(handler(key({ ctrlKey: true, shiftKey: true, code: "KeyA" }))).toBe(false);
  expect(handler(key({ ctrlKey: true, shiftKey: true, code: "KeyC" }))).toBe(false);
  expect(handler(key({ ctrlKey: true, shiftKey: true, code: "KeyV" }))).toBe(false);
  await tick();
  expect(writeText).toHaveBeenCalledWith("chosen");
  expect(hooks.calls).toEqual(["selectAll", "paste:pasted"]);
});

it("a key the terminal keeps (Ctrl+N), a plain key and a key release go to the program", () => {
  vi.stubGlobal("navigator", { userAgent: "Windows" });
  const handler = started();
  expect(handler(key({ ctrlKey: true, code: "KeyN" }))).toBe(true);
  expect(handler(key({ code: "KeyA" }))).toBe(true);
  expect(handler(key({ type: "keyup", ctrlKey: true, code: "KeyK" }))).toBe(true);
  expect(hooks.calls).toEqual([]);
});

it("a global app chord leaves xterm (it ran in the window handler)", () => {
  vi.stubGlobal("navigator", { userAgent: "Windows" });
  const handler = started();
  expect(handler(key({ ctrlKey: true, shiftKey: true, code: "KeyG" }))).toBe(false);
});

it("under terminal first the keys a TUI uses reach the program", () => {
  vi.stubGlobal("navigator", { userAgent: "Windows" });
  setKeySettings({ terminalPolicy: "terminal-first", terminalHints: true });
  const handler = started();
  expect(handler(key({ ctrlKey: true, code: "KeyF" }))).toBe(true);
  // Ctrl+K no longer clears (it yields); the global search is what is left on that chord.
  expect(handler(key({ ctrlKey: true, code: "KeyK" }))).toBe(false);
  expect(hooks.calls).toEqual([]);
});

it("the bell cue follows the setting and onBell still fires", () => {
  const classes = new Set<string>();
  const pane = {
    style: { background: "" },
    classList: { add: (c: string) => void classes.add(c), remove: (c: string) => void classes.delete(c) },
    addEventListener() {},
    removeEventListener() {},
  };
  const onBell = vi.fn();
  const { effect } = mount({ api: createMockApi({}), id: "b-1", onBell });
  (hooks.store[0].current as { parentElement?: unknown }).parentElement = pane;
  effect();
  hooks.bell?.();
  expect(onBell).toHaveBeenCalledTimes(1);
  expect(classes.has("terminal-bell")).toBe(false);
  setTerminalSettings({ ...TERMINAL_DEFAULTS, bell: "visual" });
  hooks.bell?.();
  expect(onBell).toHaveBeenCalledTimes(2);
  expect(classes.has("terminal-bell")).toBe(true);
});

it("mouseenter focuses the xterm only when focus follows mouse is on", () => {
  const { effect } = mount({ api: createMockApi({}), id: "f-1" });
  const cleanup = effect() as () => void;
  const before = hooks.focused;
  hooks.listeners.mouseenter?.({});
  expect(hooks.focused).toBe(before);
  setTerminalSettings({ ...TERMINAL_DEFAULTS, focusFollowsMouse: true });
  hooks.listeners.mouseenter?.({});
  expect(hooks.focused).toBe(before + 1);
  cleanup();
  expect(hooks.listeners.mouseenter).toBeUndefined();
});

it("builds the xterm with the proposed API on and the search addon with a highlight limit", () => {
  const { effect } = mount({ api: createMockApi({}), id: "s-1" });
  effect();
  expect(hooks.options.allowProposedApi).toBe(true);
  expect(hooks.searchOpts).toEqual({ highlightLimit: 1000 });
});

it("Ctrl+F opens the find bar through the key handler", () => {
  const { effect } = mount({ api: createMockApi({}), id: "s-2" });
  effect();
  const e = { type: "keydown", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, key: "f", code: "KeyF", preventDefault: vi.fn() } as unknown as KeyboardEvent;
  expect(hooks.keyHandler?.(e)).toBe(false);
});

const mod = { button: 0, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, clientX: 3, clientY: 4 };

it("a URL opens through the api, never through window.open", async () => {
  const api = createMockApi({});
  const open = vi.fn();
  vi.stubGlobal("window", { open });
  const { effect } = mount({ api });
  (effect() as () => void)();
  expect(hooks.webLinks).not.toBeNull();
  hooks.webLinks!.handler({ ...mod }, "https://x.dev/a");
  hooks.webLinks!.handler({ ...mod, ctrlKey: false }, "https://x.dev/plain");
  await tick();
  // With no menu host a plain click opens as well.
  expect(api.__openedUrls()).toEqual(["https://x.dev/a", "https://x.dev/plain"]);
  expect(open).not.toHaveBeenCalled();
  expect(hooks.webLinks!.options).toMatchObject({ hover: expect.any(Function), leave: expect.any(Function) });
});

it("a plain click on a URL asks for the menu when the pane has a menu host", async () => {
  const api = createMockApi({});
  const onLinkMenu = vi.fn();
  const { effect } = mount({ api, onLinkMenu });
  (effect() as () => void)();
  hooks.webLinks!.handler({ ...mod, ctrlKey: false }, "https://x.dev/a");
  expect(onLinkMenu).toHaveBeenCalledTimes(1);
  expect(onLinkMenu.mock.calls[0]![0]).toEqual({ x: 3, y: 4 });
  expect(onLinkMenu.mock.calls[0]![2]).toBe("https://x.dev/a");
  expect(api.__openedUrls()).toEqual([]);
});

it("registers a file link provider and an OSC 8 handler that route through the api", async () => {
  const api = createMockApi({});
  const { effect } = mount({ api, worktree: "/demo/wt/xdev-oak" });
  (effect() as () => void)();
  expect(hooks.providers).toHaveLength(1);
  expect(hooks.linkHandler?.allowNonHttpProtocols).toBe(true);
  hooks.linkHandler!.activate({ ...mod }, "https://x.dev/osc", { start: { x: 1, y: 1 }, end: { x: 2, y: 1 } });
  await tick();
  expect(api.__openedUrls()).toEqual(["https://x.dev/osc"]);
  // Not a web or file target: nothing opens.
  hooks.linkHandler!.activate({ ...mod }, "mailto:a@b.c", { start: { x: 1, y: 1 }, end: { x: 2, y: 1 } });
  await tick();
  expect(api.__openedUrls()).toHaveLength(1);
});

it("has no file links without a worktree", () => {
  const api = createMockApi({});
  const { effect } = mount({ api });
  (effect() as () => void)();
  let out: unknown = "pending";
  (hooks.providers[0] as { provideLinks(y: number, cb: (l: unknown) => void): void }).provideLinks(1, (l) => (out = l));
  expect(out).toBeUndefined();
});

// ---- Keys the terminal encodes itself (multi-line input, word moves, Option as Alt) ----

const typed = (init: Record<string, unknown>) => key({ key: "", keyCode: 0, isComposing: false, ...init });
const bytes = (text: string) => new TextEncoder().encode(text);

async function startedWithInput(id = "k-1", agent = false) {
  const api = createMockApi({});
  const spawn = api.ptySpawn.bind(api);
  api.ptySpawn = async (...a) => ({ ...(await spawn(...a)), agent });
  const input = vi.spyOn(api, "ptyWrite");
  const onInput = vi.fn();
  const { effect } = mount({ api, id, onInput });
  effect();
  await tick();
  return { handler: hooks.keyHandler!, input, onInput };
}

it("Shift+Enter in a plain shell is left to xterm", async () => {
  const { handler, input } = await startedWithInput("k-0");
  expect(handler(typed({ key: "Enter", code: "Enter", shiftKey: true }))).toBe(true);
  await tick();
  expect(input).not.toHaveBeenCalled();
});

it("Shift+Enter in an agent pane writes ESC CR to the pty and nothing reaches xterm", async () => {
  const { handler, input, onInput } = await startedWithInput("k-1", true);
  const e = typed({ key: "Enter", code: "Enter", shiftKey: true });
  expect(handler(e)).toBe(false);
  await tick();
  expect(input).toHaveBeenCalledWith("k-1", bytes("\x1b\r"));
  expect(onInput).toHaveBeenCalledWith("\x1b\r");
  expect(e.preventDefault).toHaveBeenCalled();
});

it("after the program pushes kitty flags Shift+Enter writes ESC[13;2u", async () => {
  const { handler, input } = await startedWithInput("k-2");
  expect(hooks.csi[">u"]([1])).toBe(false);
  expect(handler(typed({ key: "Enter", code: "Enter", shiftKey: true }))).toBe(false);
  await tick();
  expect(input).toHaveBeenCalledWith("k-2", bytes("\x1b[13;2u"));
});

it("an app chord keeps its priority and writes nothing to the pty", async () => {
  const { handler, input } = await startedWithInput("k-3");
  expect(handler(typed({ key: "f", code: "KeyF", ctrlKey: true }))).toBe(false);
  await tick();
  expect(input).not.toHaveBeenCalled();
});

it("Cmd+Up scrolls to the top on macOS and writes nothing", async () => {
  hooks.platform = "mac";
  const { handler, input } = await startedWithInput("k-4");
  expect(handler(typed({ key: "ArrowUp", code: "ArrowUp", metaKey: true }))).toBe(false);
  await tick();
  expect(hooks.calls).toEqual(["scrollToTop"]);
  expect(input).not.toHaveBeenCalled();
});

it("a key during IME composition goes to xterm untouched", async () => {
  const { handler, input } = await startedWithInput("k-5");
  expect(handler(typed({ key: "Enter", code: "Enter", shiftKey: true, isComposing: true }))).toBe(true);
  await tick();
  expect(input).not.toHaveBeenCalled();
});

it("the left Option key sends ESC + char once it is held, and a blur forgets it", async () => {
  hooks.platform = "mac";
  setTerminalSettings({ ...TERMINAL_DEFAULTS, macOptionAsAlt: "left" });
  const { handler, input } = await startedWithInput("k-6");
  handler(typed({ type: "keydown", key: "Alt", code: "AltLeft", location: 1, altKey: true }));
  expect(handler(typed({ key: "a", code: "KeyA", altKey: true }))).toBe(false);
  await tick();
  expect(input).toHaveBeenCalledWith("k-6", bytes("\x1ba"));
  hooks.listeners.focusout({});
  expect(handler(typed({ key: "a", code: "KeyA", altKey: true }))).toBe(true);
});

it("macOptionIsMeta follows the setting and the detected layout", async () => {
  hooks.platform = "mac";
  setTerminalSettings({ ...TERMINAL_DEFAULTS, macOptionAsAlt: "both" });
  await startedWithInput("k-7");
  expect(hooks.options.macOptionIsMeta).toBe(true);
  setTerminalSettings({ ...TERMINAL_DEFAULTS, macOptionAsAlt: "off" });
  expect(hooks.options.macOptionIsMeta).toBe(false);
  setTerminalSettings({ ...TERMINAL_DEFAULTS, macOptionAsAlt: "auto" });
  expect(hooks.options.macOptionIsMeta).toBe(false);
});

it("a custom scheme picks its colours, and one added later re-themes the pane", () => {
  const colors = { ...TERMINAL_SCHEMES[0]!.colors, background: "#123456" };
  setTerminalSettings({ ...TERMINAL_DEFAULTS, theme: "custom-mine" });
  const { effect } = mount({ api: createMockApi({}), id: "cs-1" });
  const cleanup = effect() as () => void;
  // Not imported yet: the app look.
  expect((hooks.options.theme as { background?: string }).background).not.toBe("#123456");
  setCustomSchemes([{ id: "custom-mine", name: "Mine", mode: "dark", colors }]);
  expect(hooks.options.theme).toEqual(colors);
  cleanup();
  resetCustomSchemesForTests();
});
