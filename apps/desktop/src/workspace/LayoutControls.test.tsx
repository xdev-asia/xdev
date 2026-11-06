import { beforeEach, expect, it, vi } from "vitest";
import { Menu } from "@xdev-asia/ui";
import type { MenuEntry } from "@xdev-asia/ui";
import { translate } from "@/i18n";
import { mount, nodes, tick, type Node } from "@/kit/testHooks";
import { single } from "./paneTree";

const lic = vi.hoisted(() => ({ state: null as unknown, allowed: false, upsell: vi.fn() }));
vi.mock("@/license/useLicense", () => ({ useLicense: () => ({ state: lic.state, allows: () => lic.allowed }) }));
vi.mock("react", async (original) => ({ ...(await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()), useContext: () => lic.upsell }));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

import { LAYOUTS_FEATURE, LayoutControls } from "./LayoutControls";

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const layout = single("t1");

function setup(saved: { name: string; layout: unknown }[] = [], save: () => Promise<void> = () => Promise.resolve()) {
  const api = {
    layoutPresetsUser: vi.fn(() => Promise.resolve(saved)),
    layoutPresetSave: vi.fn(save),
    layoutPresetDelete: vi.fn(() => Promise.resolve()),
    licenseState: vi.fn(),
    licenseRefresh: vi.fn(),
    onLicenseChanged: vi.fn(() => Promise.resolve(() => undefined)),
  };
  const sessions = { subscribe: () => () => undefined, layout: () => layout, setLayout: vi.fn() };
  const m = mount((p: Parameters<typeof LayoutControls>[0]) => LayoutControls(p)!, () => ({ api: api as never, sessions: sessions as never, worktree: "w" }));
  const items = async (): Promise<MenuEntry[]> => {
    const all = await m.settle();
    return all.find((n) => n.type === Menu)!.props.items as MenuEntry[];
  };
  return { api, sessions, m, items };
}
const labelled = (items: MenuEntry[], label: string) => items.find((i) => "label" in i && i.label.startsWith(label)) as Extract<MenuEntry, { onSelect?: () => void }>;

beforeEach(() => {
  lic.upsell.mockClear();
  lic.state = { state: "free", notice: null };
  lic.allowed = false;
});

it("free: Save current layout carries the Pro tag and opens the upsell", async () => {
  const s = setup();
  const save = labelled(await s.items(), en("layout.save"));
  expect(save.label).toBe(`${en("layout.save")} · ${en("pro.tag")}`);
  save.onSelect!();
  expect(lic.upsell).toHaveBeenCalledWith(LAYOUTS_FEATURE);
  expect(nodes(s.m.draw()).some((n) => n.props.onSave)).toBe(false);
});

it("licence not read yet: no tag, and the action waits instead of opening the upsell", async () => {
  lic.state = null;
  const s = setup();
  const save = labelled(await s.items(), en("layout.save"));
  expect(save.label).toBe(en("layout.save"));
  save.onSelect!();
  expect(lic.upsell).not.toHaveBeenCalled();
  expect(nodes(s.m.draw()).some((n) => n.props.onSave)).toBe(false);
});

it("Pro: Save current layout opens the naming dialog, and saving stores the layout", async () => {
  lic.state = { state: "active" };
  lic.allowed = true;
  const s = setup();
  const save = labelled(await s.items(), en("layout.save"));
  expect(save.label).toBe(en("layout.save"));
  save.onSelect!();
  const dialog = nodes(s.m.draw()).find((n: Node) => n.props.onSave)!;
  dialog.props.onSave("Review");
  await tick();
  expect(s.api.layoutPresetSave).toHaveBeenCalledWith("Review", expect.objectContaining({ v: 1 }));
  expect(lic.upsell).not.toHaveBeenCalled();
});

it("a license_required reply from Rust opens the upsell and closes the naming dialog", async () => {
  lic.state = { state: "active" };
  lic.allowed = true;
  const s = setup([], () => Promise.reject({ code: "license_required" }));
  labelled(await s.items(), en("layout.save")).onSelect!();
  nodes(s.m.draw()).find((n: Node) => n.props.onSave)!.props.onSave("Review");
  await tick();
  expect(lic.upsell).toHaveBeenCalledWith(LAYOUTS_FEATURE);
  expect(nodes(s.m.draw()).some((n) => n.props.onSave)).toBe(false);
});

it("with no saved layouts there is no Saved layouts heading and no delete entry", async () => {
  const items = await setup().items();
  expect(items.some((i) => i.type === "group" && i.label === en("layout.menu.saved"))).toBe(false);
  expect(items.some((i) => "label" in i && i.label === en("layout.manage"))).toBe(false);
});

it("saved layouts are listed once, and deleting is one entry that opens a dialog, not a danger item per layout", async () => {
  const s = setup([{ name: "Review", layout: { v: 1 } }, { name: "Focus", layout: { v: 1 } }]);
  const items = await s.items();
  expect(items.some((i) => i.type === "group" && i.label === en("layout.menu.saved"))).toBe(true);
  expect(items.filter((i) => "danger" in i && i.danger)).toHaveLength(0);
  expect(items.some((i) => "label" in i && i.label === "Review")).toBe(true);
  labelled(items, en("layout.manage")).onSelect!();
  const dialog = nodes(s.m.draw()).find((n: Node) => n.props.saved);
  expect(dialog).toBeDefined();
  dialog!.props.onDelete("Focus");
  expect(s.api.layoutPresetDelete).toHaveBeenCalledWith("Focus");
});
