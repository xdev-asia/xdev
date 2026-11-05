import type { ReactElement } from "react";
import { expect, it, vi } from "vitest";
import { translate } from "@/i18n";
import { mount, nodes, textOf, type Node } from "@/kit/testHooks";
import { ResourceManager, type ResourceManagerProps } from "./ResourceManager";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const View = ResourceManager as unknown as (p: ResourceManagerProps) => ReactElement;
const MB = 1024 * 1024;
const snapshot = {
  app: { pid: 1, cpu: 1.5, memoryBytes: 200 * MB, processes: 1 },
  tabs: [
    { tabId: "small", pid: 11, cpu: 0.5, memoryBytes: 50 * MB, processes: 1 },
    { tabId: "big", pid: 12, cpu: 12.25, memoryBytes: 900 * MB, processes: 3 },
  ],
};

function setup() {
  const stopped: string[] = [];
  const api = { resourcesSnapshot: vi.fn(async () => snapshot) };
  const m = mount(View, () => ({
    api,
    tabs: () => [
      { id: "big", title: "Build", agent: "Claude" },
      { id: "small", title: "Shell", agent: "Terminal" },
    ],
    onStop: async (id: string) => void stopped.push(id),
    onClose() {},
  }));
  return { api, m, stopped };
}

const rowsOf = (all: Node[]) => all.filter((n) => n.props["data-resource-tab"] !== undefined);

it("lists the app and each tab, biggest memory first, with CPU and memory", async () => {
  const { m, api } = setup();
  const all = await m.settle();
  expect(api.resourcesSnapshot).toHaveBeenCalledTimes(1);
  expect(all.some((n) => n.props["data-resource-app"] !== undefined)).toBe(true);
  expect(rowsOf(all).map((r) => r.props["data-resource-tab"])).toEqual(["big", "small"]);
  const first = textOf(rowsOf(all)[0]);
  expect(first).toContain("Build");
  expect(first).toContain("Claude");
  expect(first).toContain("12.3%");
  expect(first).toContain("900 MB");
});

it("asks before stopping, and stops only after the confirm", async () => {
  const { m, stopped } = setup();
  const all = await m.settle();
  const stop = nodes(rowsOf(all)[0]).find((n) => n.type === "button")!;
  expect(stop.props["aria-label"]).toBe(en("resources.stop.label", { name: "Build" }));
  stop.props.onClick();
  const dialog = m.draw() as Node;
  expect(dialog.props.alert).toBe(true);
  expect(dialog.props.title).toBe(en("resources.stop.title", { name: "Build" }));
  expect(stopped).toEqual([]);
  // Cancel goes back to the list without stopping.
  dialog.props.onCancel();
  expect((m.draw() as Node).props.title).toBe(en("resources.title"));
  expect(stopped).toEqual([]);
  stop.props.onClick();
  (m.draw() as Node).props.onConfirm();
  expect(stopped).toEqual(["big"]);
});
