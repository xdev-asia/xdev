import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi, type Api, type PortScan, type WorkspacePort } from "@/api";
import { translate } from "@/i18n";
import { lastOpenedPort } from "@/mockPorts";
import { PortsPanel } from "./PortsPanel";
import { PortsStore } from "./portsStore";

const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0, effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const state = (initial: unknown) => {
    const index = hooks.cursor++;
    const values = hooks.values;
    if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
    return [values[index], (value: unknown) => { values[index] = typeof value === "function" ? value(values[index]) : value; }];
  };
  return {
    ...react,
    useState: (initial: any) => (hooks.active ? state(initial) : react.useState(initial)),
    useEffect: (effect: any, deps?: any) => (hooks.active ? void hooks.effects.push(effect) : react.useEffect(effect, deps)),
    useCallback: (fn: any, deps: any) => (hooks.active ? fn : react.useCallback(fn, deps)),
    useSyncExternalStore: (subscribe: any, get: any, server?: any) => (hooks.active ? get() : react.useSyncExternalStore(subscribe, get, server)),
  };
});
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children), ...nodes(node.props.title), ...nodes(node.props.trailing), ...nodes(node.props.leading), ...nodes(node.props.meta)];
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const OAK = "/demo/wt/xdev-oak";

function mount(api: Api, store: PortsStore, active: string | null = OAK, visible = true) {
  const values: unknown[] = [];
  const draw = () => {
    hooks.values = values;
    hooks.cursor = 0;
    hooks.active = true;
    try { return PortsPanel({ api, store, active, visible }); } finally { hooks.active = false; }
  };
  const before = hooks.effects.length;
  draw();
  const cleanups = hooks.effects.slice(before).map((effect) => effect());
  return { all: () => nodes(draw()), html: () => renderToStaticMarkup(draw()), cleanups };
}

function port(p: Partial<WorkspacePort> & { port: number }): WorkspacePort {
  return {
    id: `localhost:${p.port}:1`, bindHost: "::", connectHost: "localhost", pid: 1, processName: null, protocol: "http",
    kind: "workspace", worktree: null, evidence: null, url: `http://localhost:${p.port}`, advertised: false, ...p,
  };
}
function scan(ports: WorkspacePort[], extra: Partial<PortScan> = {}): PortScan {
  return { platform: "windows", scannedAt: 1, ports, unavailable: null, detail: null, retryIn: null, ...extra };
}
function storeWith(api: Api, result: PortScan | Error): PortsStore {
  vi.spyOn(api, "portsScan").mockImplementation(async () => { if (result instanceof Error) throw result; return result; });
  const store = new PortsStore(api);
  store.setWorktrees([OAK]);
  return store;
}

let now = 1_000_000;
/** Time passes, so a confirm button that just appeared accepts a click. */
const pass = (ms = 500) => { now += ms; };
const click = { detail: 1 };

beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false;
  vi.stubGlobal("window", new EventTarget());
  now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("groups ports and shows the process, the address and the owner", async () => {
  const api = createMockApi({});
  const store = storeWith(api, scan([
    port({ port: 5173, pid: 41, processName: "node", worktree: OAK, evidence: "terminal" }),
    port({ port: 3000, pid: 42, processName: null, worktree: "/demo/wt/other", evidence: "cwd" }),
    port({ port: 8080, pid: null, kind: "container" }),
    port({ port: 5432, pid: 7, processName: "postgres", kind: "external" }),
  ]));
  await store.refresh();
  const html = mount(api, store).html();
  for (const key of ["ports.section.active", "ports.section.other", "ports.section.external"]) expect(html).toContain(en(key));
  expect(html).toContain(":5173");
  expect(html).toContain(">node<");
  expect(html).toContain("localhost:5173");
  expect(html).toContain("xdev-oak");
  expect(html).toContain(en("ports.evidence.terminal"));
  expect(html).toContain(en("ports.process.pid", { pid: 42 }));
  expect(html).toContain(en("ports.process.unknown"));
  expect(html).toContain(en("ports.owner.container"));
  expect(html).toContain(en("ports.owner.unassigned"));
  // Stop is offered only for a workspace port with a pid.
  expect(html.match(new RegExp(`aria-label="${en("ports.stop")}"`, "g")) ?? []).toHaveLength(2);
});

it("says why there is nothing to show", async () => {
  const api = createMockApi({});
  const idle = new PortsStore(api);
  expect(mount(api, idle, null).html()).toContain(en("ports.empty.noWorkspace"));
  expect(mount(api, idle).html()).toContain(en("ports.empty.scanning"));
  const store = storeWith(api, scan([]));
  await store.refresh();
  expect(mount(api, store).html()).toContain(en("ports.empty.none"));
  const idleScan = storeWith(api, scan([], { unavailable: "no_terminal" }));
  await idleScan.refresh();
  const idleHtml = mount(api, idleScan).html();
  expect(idleHtml).toContain(en("ports.empty.noTerminal"));
  expect(idleHtml).not.toContain(en("ports.unavailable", { platform: "windows", reason: "no_terminal" }));
  const outside = storeWith(api, scan([port({ port: 1, kind: "external" })]));
  await outside.refresh();
  expect(mount(api, outside).html()).toContain(en("ports.empty.noLocal"));
});

it("shows an unavailable scan and a pause", async () => {
  const api = createMockApi({});
  const down = storeWith(api, scan([], { unavailable: "scan_failed", detail: "netstat missing" }));
  await down.refresh();
  expect(mount(api, down).html()).toContain(en("ports.unavailable", { platform: "windows", reason: "netstat missing" }));
  const paused = storeWith(api, scan([], { unavailable: "scan_timeout", retryIn: 45 }));
  await paused.refresh();
  expect(mount(api, paused).html()).toContain(en("ports.paused", { seconds: 45 }));
});

it("shows a failed call with its error string", async () => {
  const api = createMockApi({});
  const store = storeWith(api, Object.assign(new Error("x"), { code: "scan_failed" }));
  await store.refresh();
  expect(mount(api, store).html()).toContain(en("error.scan_failed"));
});

it("opens a port in the browser by id", async () => {
  const api = createMockApi({});
  const store = storeWith(api, scan([port({ port: 5173, worktree: OAK })]));
  await store.refresh();
  const m = mount(api, store);
  m.all().find((n) => n.props["aria-label"] === en("ports.open") || n.props.label === en("ports.open"))?.props.onClick();
  await tick();
  expect(lastOpenedPort()).toBe("localhost:5173:1");
});

it("stops a port under an xDev terminal after a confirming click and tells the person", async () => {
  const api = createMockApi({});
  const store = storeWith(api, scan([port({ port: 5173, pid: 9, worktree: OAK, evidence: "terminal" })]));
  await store.refresh();
  const stop = vi.spyOn(store, "stop").mockResolvedValue();
  const m = mount(api, store);
  m.all().find((n) => n.props.label === en("ports.stop"))?.props.onClick();
  await tick();
  // The first click only asks.
  expect(stop).not.toHaveBeenCalled();
  const confirm = m.all().find((n) => n.props["data-action"] === "stop-confirm");
  expect(confirm?.props.children).toBe(en("ports.stopConfirm", { port: 5173 }));
  expect(m.all().filter((n) => n.props["data-action"] === "stop-confirm" || n.props.variant === "primary")).toHaveLength(1);
  pass();
  confirm?.props.onClick(click);
  await tick();
  expect(stop).toHaveBeenCalledWith("localhost:5173:1", { confirmed: true, outsideTerminal: false });
  expect(m.html()).toContain(en("ports.stopped", { port: 5173 }));
});

it("asks a second time before stopping a port no xDev terminal started", async () => {
  const api = createMockApi({});
  const store = storeWith(api, scan([port({ port: 3000, pid: 9, worktree: OAK, evidence: "cwd" })]));
  await store.refresh();
  const stop = vi.spyOn(store, "stop").mockResolvedValue();
  const m = mount(api, store);
  m.all().find((n) => n.props.label === en("ports.stop"))?.props.onClick();
  pass();
  m.all().find((n) => n.props["data-action"] === "stop-confirm")?.props.onClick(click);
  await tick();
  expect(stop).not.toHaveBeenCalled();
  expect(m.html()).toContain(en("ports.stopOutsideNote", { port: 3000 }));
  pass();
  m.all().find((n) => n.props["data-action"] === "stop-outside")?.props.onClick(click);
  await tick();
  expect(stop).toHaveBeenCalledWith("localhost:3000:1", { confirmed: true, outsideTerminal: true });
});

it("asks a second time when the listener is the terminal's own process", async () => {
  const api = createMockApi({});
  const store = storeWith(api, scan([port({ port: 4000, pid: 9, worktree: OAK, evidence: "terminal" })]));
  await store.refresh();
  const stop = vi.spyOn(store, "stop").mockRejectedValueOnce({ code: "port_terminal_root" }).mockResolvedValue();
  const m = mount(api, store);
  m.all().find((n) => n.props.label === en("ports.stop"))?.props.onClick();
  pass();
  m.all().find((n) => n.props["data-action"] === "stop-confirm")?.props.onClick(click);
  await tick();
  expect(stop).toHaveBeenCalledWith("localhost:4000:1", { confirmed: true, outsideTerminal: false });
  expect(m.all().some((n) => n.props.children === en("ports.stopTerminalNote", { port: 4000 }))).toBe(true);
  expect(m.html()).not.toContain('role="alert"');
  pass();
  m.all().find((n) => n.props["data-action"] === "stop-outside")?.props.onClick(click);
  await tick();
  expect(stop).toHaveBeenLastCalledWith("localhost:4000:1", { confirmed: true, outsideTerminal: true });
});

it("ignores the extra clicks of a double or triple click and a click right after a confirm appears", async () => {
  const api = createMockApi({});
  const store = storeWith(api, scan([port({ port: 3000, pid: 9, worktree: OAK, evidence: "cwd" })]));
  await store.refresh();
  const stop = vi.spyOn(store, "stop").mockResolvedValue();
  const m = mount(api, store);
  const confirm = () => m.all().find((n) => n.props["data-action"] === "stop-confirm");
  const outside = () => m.all().find((n) => n.props["data-action"] === "stop-outside");
  // A triple click on Stop: the 2nd and 3rd land on the confirm that took its place.
  m.all().find((n) => n.props.label === en("ports.stop"))?.props.onClick({ detail: 1 });
  confirm()?.props.onClick({ detail: 2 });
  confirm()?.props.onClick({ detail: 3 });
  expect(outside()).toBeUndefined();
  // A single click too soon after the confirm appeared.
  pass(100);
  confirm()?.props.onClick(click);
  expect(outside()).toBeUndefined();
  pass();
  confirm()?.props.onClick(click);
  expect(outside()).toBeDefined();
  // The override confirm takes the same guard.
  outside()?.props.onClick({ detail: 2 });
  outside()?.props.onClick({ detail: 3 });
  outside()?.props.onClick(click);
  pass();
  outside()?.props.onClick({ detail: 3 });
  await tick();
  expect(stop).not.toHaveBeenCalled();
  outside()?.props.onClick(click);
  await tick();
  expect(stop).toHaveBeenCalledTimes(1);
  expect(stop).toHaveBeenCalledWith("localhost:3000:1", { confirmed: true, outsideTerminal: true });
});

it("cancels an asked stop and the menu entry only asks", async () => {
  const api = createMockApi({});
  const store = storeWith(api, scan([port({ port: 5173, pid: 9, worktree: OAK, evidence: "terminal" })]));
  await store.refresh();
  const stop = vi.spyOn(store, "stop").mockResolvedValue();
  const m = mount(api, store);
  m.all().find((n) => n.props.label === en("ports.stop"))?.props.onClick();
  m.all().find((n) => n.props.label === en("dialog.cancel"))?.props.onClick();
  expect(m.all().some((n) => n.props["data-action"] === "stop-confirm")).toBe(false);
  expect(stop).not.toHaveBeenCalled();
});

it("is polled only while visible", () => {
  const api = createMockApi({});
  const store = new PortsStore(api);
  const vis = vi.spyOn(store, "setVisible");
  const m = mount(api, store, OAK, true);
  expect(vis).toHaveBeenLastCalledWith(true);
  m.cleanups.forEach((c) => typeof c === "function" && c());
  expect(vis).toHaveBeenLastCalledWith(false);
});
