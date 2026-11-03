import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Button } from "@xdev/ui";
import { createMockApi, type VaultView } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { translate } from "../i18n";
import { DEMO_WORKSPACE } from "../mockWorkspace";
import { VaultsSettings } from "./VaultsSettings";

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

async function view(seed: { docs?: string[]; vaults?: string[] } = {}, listed?: VaultView[]) {
  const api = createMockApi({}, { workspace: { ...structuredClone(DEMO_WORKSPACE), ...seed } });
  if (listed) vi.spyOn(api, "vaultList").mockResolvedValue(listed);
  const onChanged = vi.fn();
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return VaultsSettings({ api, onChanged }); } finally { hooks.active = false; }
  };
  draw();
  hooks.effects.forEach((e) => e());
  await tick();
  const all = () => nodes(draw());
  const rows = (kind: string) => all().filter((n) => n.type === "li" && n.props["data-kind"] === kind);
  const button = (row: Node, label: string) => nodes(row).find((n) => n.type === "button" && n.props.children === label);
  const dialog = () => all().find((n) => n.type === ConfirmDialog)!;
  const add = () => all().find((n) => n.type === Button && n.props.children === en("settings.vaults.add"))!;
  return { api, onChanged, all, rows, button, dialog, add };
}

it("create docs for a repo without a vault", async () => {
  const v = await view();
  const create = vi.spyOn(v.api, "vaultCreateDocs");
  const [row] = v.rows("repo");
  const button = v.button(row, en("settings.vaults.create"))!;
  expect(button).toBeDefined();
  button.props.onClick();
  await tick();
  expect(create).toHaveBeenCalledWith("demo-xdev", en("vault.starter.file"), en("vault.starter.content"));
  expect(v.button(v.rows("repo")[0], en("settings.vaults.create"))).toBeUndefined();
  expect(v.onChanged).toHaveBeenCalledTimes(1);
});

it("a repo with docs offers no create", async () => {
  const v = await view({ docs: ["demo-xdev"] });
  expect(v.button(v.rows("repo")[0], en("settings.vaults.create"))).toBeUndefined();
  expect(v.all().some((n) => n.props.children === en("settings.vaults.noShared"))).toBe(true);
});

it("add shared vault from the picker then forget it after confirming", async () => {
  const v = await view();
  vi.spyOn(v.api, "pickFolder").mockResolvedValue("/demo/shared-docs");
  const forget = vi.spyOn(v.api, "vaultForget");
  expect(v.rows("shared")).toHaveLength(0);

  v.add().props.onClick();
  await tick();
  expect(v.rows("shared")).toHaveLength(1);
  expect(nodes(v.rows("shared")[0]).some((n) => n.props.children === "/demo/shared-docs")).toBe(true);
  expect(v.onChanged).toHaveBeenCalledTimes(1);

  // Adding the same folder again is refused, in words.
  v.add().props.onClick();
  await tick();
  expect(v.all().some((n) => n.props.role === "alert" && n.props.children === en("error.vault_exists"))).toBe(true);

  expect(v.dialog().props.open).toBe(false);
  v.button(v.rows("shared")[0], en("settings.vaults.forget"))!.props.onClick();
  expect(v.dialog().props.open).toBe(true);
  expect(v.dialog().props.body).toBe(en("settings.vaults.forgetBody", { path: "/demo/shared-docs" }));
  expect(forget).not.toHaveBeenCalled();
  v.dialog().props.onConfirm();
  await tick();
  expect(forget).toHaveBeenCalledWith("shared:/demo/shared-docs");
  expect(v.rows("shared")).toHaveLength(0);
  expect(v.dialog().props.open).toBe(false);
});

it("cancelling the forget keeps the vault", async () => {
  const gone = { id: "shared:/demo/gone", kind: "shared" as const, path: "/demo/gone", name: "gone", repoId: null, exists: false };
  const v = await view({}, [gone]);
  const row = v.rows("shared")[0];
  expect(nodes(row).some((n) => n.props.children === en("settings.vaults.missing"))).toBe(true);
  v.button(row, en("settings.vaults.forget"))!.props.onClick();
  v.dialog().props.onCancel();
  expect(v.dialog().props.open).toBe(false);
  expect(v.rows("shared")).toHaveLength(1);
});
