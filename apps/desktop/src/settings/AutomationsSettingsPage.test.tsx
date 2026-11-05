import { afterEach, expect, it, vi } from "vitest";
import { createMockApi } from "@/api";
import { mount, textOf, tick, type Node } from "@/kit/testHooks";
import { translate } from "@/i18n";
import { getAutomationsSettings, resetAutomationsSettingsForTests } from "./automationsSettings";
import { AutomationsSettingsPage } from "./AutomationsSettingsPage";
import { runSearch } from "./searchModel";
import { SECTIONS } from "./sections";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

afterEach(resetAutomationsSettingsForTests);

const t = (key: string) => translate("en", key);
const sw = (all: Node[], key: string) => all.find((n) => n.props["data-switch"] === key)!;
const toggle = (all: Node[], key: string) => nodesOf(sw(all, key)).find((n) => n.props.role === "switch")!;
function nodesOf(n: Node): Node[] {
  const out: Node[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object" && "props" in v) {
      const node = v as Node;
      out.push(node);
      walk(node.props.children);
    }
  };
  walk(n.props.children);
  return out;
}

async function open() {
  const api = createMockApi({});
  const openView = vi.fn();
  const m = mount(AutomationsSettingsPage, () => ({ api, onChanged: vi.fn(), openView }));
  await m.settle();
  await m.settle();
  return { api, m, openView };
}

it("is a section of Settings", () => {
  const section = SECTIONS.find((s) => s.id === "automations")!;
  expect(section.labelKey).toBe("settings.automations.title");
  expect(section.Component).toBe(AutomationsSettingsPage);
});

it("shows the two switches with their defaults: the button on, the confirmation on", async () => {
  const { m } = await open();
  const all = m.all();
  expect(textOf(all.find((n) => n.type === "h3")!)).toBe("Automations");
  expect(toggle(all, "showButton").props["aria-checked"]).toBe(true);
  expect(toggle(all, "showButton").props["aria-label"]).toBe("Show Automations button");
  expect(toggle(all, "confirmDelete").props["aria-checked"]).toBe(true);
  expect(toggle(all, "confirmDelete").props["aria-label"]).toBe("Confirm before deleting an automation");
});

it("hiding the button is stored and applied to the window", async () => {
  const { api, m } = await open();
  toggle(m.all(), "showButton").props.onClick();
  await tick();
  expect(await api.automationsSettings()).toEqual({ showButton: false, skipDeleteConfirm: false });
  expect(getAutomationsSettings().showButton).toBe(false);
  await m.settle();
  expect(toggle(m.all(), "showButton").props["aria-checked"]).toBe(false);
});

it("the confirmation switch is stored inverted as skipDeleteConfirm", async () => {
  const { api, m } = await open();
  toggle(m.all(), "confirmDelete").props.onClick();
  await tick();
  expect(await api.automationsSettings()).toEqual({ showButton: true, skipDeleteConfirm: true });
  await m.settle();
  expect(toggle(m.all(), "confirmDelete").props["aria-checked"]).toBe(false);
  toggle(m.all(), "confirmDelete").props.onClick();
  await tick();
  expect((await api.automationsSettings()).skipDeleteConfirm).toBe(false);
});

it("explains how it works in three steps and opens the Automations view", async () => {
  const { m, openView } = await open();
  const all = m.all();
  const steps = all.filter((n) => n.type === "li" && !n.props["data-switch"]).map((n) => textOf(n.props.children[0]));
  expect(steps).toEqual(["Describe the work", "xDev starts each run", "Review the results"]);
  const button = all.find((n) => n.props["data-act"] === "open-automations")!;
  expect(button.props.variant).toBe("secondary");
  expect(textOf(button)).toBe("Open Automations");
  button.props.onClick();
  expect(openView).toHaveBeenCalledWith("automations");
});

it("is found by the settings search", () => {
  const labelOf = (id: string) => t(SECTIONS.find((s) => s.id === id)?.labelKey ?? id);
  for (const query of ["automations", "delete", "show automations button"]) {
    const found = runSearch(query, t, labelOf);
    expect([...found.ids].some((id) => id.startsWith("automations.")), query).toBe(true);
  }
  expect([...runSearch("tự động hóa", (k) => translate("vi", k), labelOf).ids].some((id) => id.startsWith("automations."))).toBe(true);
});
