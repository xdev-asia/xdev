import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi, type PortScan, type WorkspacePort } from "@/api";
import { translate } from "@/i18n";
import { PortsItem, PortsItemView } from "./PortsItem";
import { PortsStore } from "./portsStore";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const OAK = "/demo/wt/xdev-oak";

function port(p: Partial<WorkspacePort> & { port: number }): WorkspacePort {
  return { id: `x:${p.port}`, bindHost: "::", connectHost: "localhost", pid: 1, processName: null, protocol: "http", kind: "workspace", worktree: OAK, evidence: null, url: "", advertised: false, ...p };
}
async function storeWith(ports: WorkspacePort[]): Promise<PortsStore> {
  const api = createMockApi({});
  const scan: PortScan = { platform: "windows", scannedAt: 1, ports, unavailable: null, detail: null, retryIn: null };
  vi.spyOn(api, "portsScan").mockResolvedValue(scan);
  const store = new PortsStore(api);
  await store.refresh();
  return store;
}

beforeEach(() => vi.stubGlobal("window", new EventTarget()));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("shows the number of ports of the worktree in front", async () => {
  const store = await storeWith([port({ port: 1 }), port({ port: 2 }), port({ port: 3, worktree: "/other" })]);
  const html = renderToStaticMarkup(createElement(PortsItem, { store, active: OAK, onOpen() {} }));
  expect(html).toContain(en("ports.status.label", { count: 2 }));
  expect(html).toContain(`title="${en("ports.status.title")}"`);
});

it("mentions ports outside the workspaces in the title", async () => {
  const store = await storeWith([port({ port: 1 }), port({ port: 2, kind: "external", worktree: null })]);
  const html = renderToStaticMarkup(createElement(PortsItem, { store, active: OAK, onOpen() {} }));
  expect(html).toContain(en("ports.status.titleExternal", { external: 1 }));
});

it("shows only the name before the first scan, and opens the panel on click", () => {
  const store = new PortsStore(createMockApi({}));
  expect(renderToStaticMarkup(createElement(PortsItem, { store, active: OAK, onOpen() {} }))).toContain(`>${en("ports.tab")}<`);
  const onOpen = vi.fn();
  const el = PortsItemView({ counts: null, onOpen }) as ReactElement<Record<string, any>>;
  expect(renderToStaticMarkup(el)).toContain(`>${en("ports.tab")}<`);
  el.props.onClick();
  expect(onOpen).toHaveBeenCalledOnce();
});
