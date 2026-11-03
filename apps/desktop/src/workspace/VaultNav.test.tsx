import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { createMockApi, type VaultView } from "../api";
import { translate } from "../i18n";
import { DEMO_WORKSPACE } from "../mockWorkspace";
import { VaultNav } from "./VaultNav";

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
    useEffect: (effect: any, deps?: any) => (hooks.active ? void hooks.effects.push(effect) : react.useEffect(effect, deps)),
  };
});
vi.mock("../i18n", async (original) => ({ ...await original<typeof import("../i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false; });

async function view(listed?: VaultView[], last?: string, canOpen?: () => boolean) {
  const api = createMockApi({}, { workspace: { ...structuredClone(DEMO_WORKSPACE), docs: ["demo-xdev"], vaults: ["/demo/shared-docs"] } });
  if (listed) vi.spyOn(api, "vaultList").mockResolvedValue(listed);
  if (last) vi.spyOn(api, "lastVault").mockResolvedValue(last);
  const onOpened = vi.fn();
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return VaultNav({ api, onOpened, canOpen }); } finally { hooks.active = false; }
  };
  draw();
  hooks.effects.forEach((e) => e());
  await tick();
  const all = () => nodes(draw());
  const rows = () => all().filter((n) => n.type === "button" && n.props.className === "ws-vault");
  const row = (path: string) => rows().find((n) => n.props["data-path"] === path)!;
  return { api, onOpened, all, rows, row };
}

it("VaultNav opens a vault and marks it current", async () => {
  const v = await view();
  const open = vi.spyOn(v.api, "openVault");
  expect(v.rows().map((n) => n.props["data-path"])).toEqual(["/demo/xdev/docs", "/demo/shared-docs"]);
  expect(v.rows().map((n) => n.props["aria-current"])).toEqual([undefined, undefined]);

  v.row("/demo/shared-docs").props.onClick();
  await tick();
  expect(open).toHaveBeenCalledWith("/demo/shared-docs");
  expect(v.onOpened).toHaveBeenCalledWith("/demo/shared-docs");
  expect(v.row("/demo/shared-docs").props["aria-current"]).toBe("true");
  expect(await v.api.lastVault()).toBe("/demo/shared-docs");
});

it("the last vault is current, a repo without docs is left out and a missing shared folder is disabled", async () => {
  const listed: VaultView[] = [
    { id: "repo:demo-xdev", kind: "repo", path: "/demo/xdev/docs", name: "xdev", repoId: "demo-xdev", exists: true },
    { id: "repo:demo-tools", kind: "repo", path: "/demo/tools/docs", name: "tools", repoId: "demo-tools", exists: false },
    { id: "shared:/demo/gone", kind: "shared", path: "/demo/gone", name: "gone", repoId: null, exists: false },
  ];
  const v = await view(listed, "/demo/xdev/docs");
  const rows = v.all().filter((n) => n.type === "button" && n.props.className === "ws-vault");
  expect(rows.map((n) => n.props["data-path"])).toEqual(["/demo/xdev/docs", "/demo/gone"]);
  expect(rows[0].props["aria-current"]).toBe("true");
  expect(rows[1].props.disabled).toBe(true);
  expect(rows[1].props.title).toBe(en("workspace.vaults.missing", { path: "/demo/gone" }));
});

it("a refused open shows why and calls nothing back", async () => {
  const v = await view();
  vi.spyOn(v.api, "openVault").mockRejectedValue({ code: "not_found", message: "gone" });
  v.row("/demo/shared-docs").props.onClick();
  await tick();
  expect(v.onOpened).not.toHaveBeenCalled();
  expect(v.all().some((n) => n.props.role === "alert")).toBe(true);
});

it("unsaved edits in the open doc keep the vault", async () => {
  const v = await view(undefined, undefined, () => false);
  const open = vi.spyOn(v.api, "openVault");
  v.row("/demo/shared-docs").props.onClick();
  await tick();
  expect(open).not.toHaveBeenCalled();
  expect(v.onOpened).not.toHaveBeenCalled();
  expect(v.all().find((n) => n.props.role === "alert")?.props.children).toBe(en("workspace.vaults.unsaved"));
});
