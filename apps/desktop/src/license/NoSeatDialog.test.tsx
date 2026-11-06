import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Button, Dialog } from "@xdev-asia/ui";
import { translate } from "@/i18n";
import { createMockLicense } from "@/mockLicense";
import { NoSeatDialog, seatHolders } from "./NoSeatDialog";

const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0, effects: [] as (() => void | (() => void))[], deps: [] as unknown[][], at: 0 }));
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
    useEffect: (effect: any, deps?: any[]) => {
      if (!hooks.active) return react.useEffect(effect, deps);
      const i = hooks.at++;
      const before = hooks.deps[i];
      hooks.deps[i] = deps ?? [];
      if (!deps || !before || deps.some((d, k) => !Object.is(d, before[k]))) hooks.effects.push(effect);
    },
  };
});
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

beforeEach(() => { hooks.values = []; hooks.deps = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false; });

async function view(onClose = vi.fn()) {
  const api = createMockLicense("noseat");
  const draw = () => {
    hooks.cursor = 0;
    hooks.at = 0;
    hooks.effects = [];
    hooks.active = true;
    try { return NoSeatDialog({ api, onClose }); } finally { hooks.active = false; }
  };
  const settle = async () => {
    for (let i = 0; i < 3; i++) { draw(); hooks.effects.forEach((e) => e()); await tick(); }
  };
  await settle();
  const all = () => nodes(draw());
  return { api, onClose, settle, all, buttons: () => all().filter((n) => n.type === Button) };
}

it("seatHolders keeps the devices that hold a seat and are not removed", async () => {
  const rows = await createMockLicense("noseat").licenseDevices();
  expect(seatHolders(rows).map((d) => d.id)).toEqual(["dev-studio"]);
  expect(seatHolders(rows.map((d) => ({ ...d, revokedAt: 1 })))).toEqual([]);
});

it("is a modal dialog listing the holder with a secondary Move license here button", async () => {
  const v = await view();
  const dialog = v.all().find((n) => n.type === Dialog)!;
  expect(dialog.props.modal).toBe(true);
  expect(dialog.props.title).toBe(en("license.noSeat.title"));
  expect(v.all().some((n) => n.type === "strong" && n.props.children === "studio-mac")).toBe(true);
  const move = v.buttons().find((b) => b.props.children === en("license.noSeat.move"))!;
  expect(move.props.variant).toBe("secondary");
  expect(move.props["aria-label"]).toBe(en("license.noSeat.moveFrom", { name: "studio-mac" }));
});

it("Move license here deactivates the holder, activates this device and closes", async () => {
  const v = await view();
  const deactivate = vi.spyOn(v.api, "licenseDeactivate");
  v.buttons().find((b) => b.props.children === en("license.noSeat.move"))!.props.onClick();
  await v.settle();
  expect(deactivate).toHaveBeenCalledWith("dev-studio");
  expect(v.onClose).toHaveBeenCalledTimes(1);
  expect((await v.api.licenseState()).state).toBe("active");
});

it("a failed move shows the error in an alert and stays open", async () => {
  const v = await view();
  vi.spyOn(v.api, "licenseDeactivate").mockRejectedValue({ code: "license_unavailable" });
  v.buttons().find((b) => b.props.children === en("license.noSeat.move"))!.props.onClick();
  await v.settle();
  expect(v.onClose).not.toHaveBeenCalled();
  expect(v.all().find((n) => n.props.role === "alert")!.props.children).toBe(en("error.license_unavailable"));
});
