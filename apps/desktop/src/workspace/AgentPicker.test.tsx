import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Button, SearchPicker } from "@xdev-asia/ui";
import { translate } from "@/i18n";
import type { ProfilesView } from "@/api";
import { createMockApi } from "@/mockApi";
import { AgentPicker, agentMenuItems, pickerEntries } from "./AgentPicker";

vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => [typeof initial === "function" ? (initial as () => unknown)() : initial, () => {}], useRef: () => ({ current: null }), useEffect: () => {} };
});
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const en = (key: string) => translate("en", key);

async function setup(prep?: (api: ReturnType<typeof createMockApi>) => Promise<unknown> | void) {
  const api = createMockApi({});
  await prep?.(api);
  const view = await api.profiles();
  const calls = { pick: vi.fn(), close: vi.fn(), manage: vi.fn(), view: vi.fn() };
  const draw = (query = "") =>
    nodes(AgentPicker({ api, view, initialQuery: query, onPick: calls.pick, onClose: calls.close, onManage: calls.manage, onView: calls.view }));
  return { api, view, calls, draw };
}

it("shows the search strings, the blank terminal first, then the installed agents", async () => {
  const { draw } = await setup();
  const picker = draw().find((n) => n.type === SearchPicker)!;
  expect(picker.props.placeholder).toBe(en("workspace.agentPicker.search"));
  expect(picker.props.label).toBe(en("workspace.agentPicker.label"));
  expect(picker.props.items.map((i: { id: string }) => i.id)).toEqual(["blank", "claude", "codex", "aider"]);
  expect(picker.props.status).toBeUndefined();
});

it("an unmatched query shows the empty line", async () => {
  const { draw } = await setup();
  const picker = draw("zzzz").find((n) => n.type === SearchPicker)!;
  expect(picker.props.items).toEqual([]);
  expect(picker.props.status).toBe(en("workspace.agentPicker.empty"));
});

it("a pick launches the agent, and the blank terminal as null", async () => {
  const { draw, calls } = await setup();
  const picker = draw().find((n) => n.type === SearchPicker)!;
  picker.props.onPick("codex");
  expect(calls.pick).toHaveBeenLastCalledWith("codex");
  picker.props.onPick("blank");
  expect(calls.pick).toHaveBeenLastCalledWith(null);
});

it("manage agents opens the settings and closes the picker", async () => {
  const { draw, calls } = await setup();
  const manage = draw().find((n) => n.type === Button && n.props.children === en("workspace.agentPicker.manage"))!;
  expect(manage.props.variant).toBe("secondary");
  manage.props.onClick();
  expect(calls.manage).toHaveBeenCalledOnce();
  expect(calls.close).toHaveBeenCalledOnce();
});

it("the row menu sets a default, and the current default is disabled", async () => {
  const { api, view, calls } = await setup(async (a) => { await a.profilesDefaults("ask", "codex", null); });
  const current = agentMenuItems(api, view, "codex", calls.view);
  expect(current).toHaveLength(1);
  expect(current[0].labelKey).toBe("workspace.agentPicker.isDefault");
  expect(current[0].disabled).toBe(true);
  const other = agentMenuItems(api, view, "claude", calls.view);
  expect(other[0].labelKey).toBe("workspace.agentPicker.setDefault");
  other[0].run!();
  await vi.waitFor(() => expect(calls.view).toHaveBeenCalled(), { timeout: 2_000 });
  expect((calls.view.mock.calls[0][0] as ProfilesView).defaultAgent).toBe("claude");
});

it("the blank terminal's menu sets blank as the default", async () => {
  const { api, view, calls } = await setup();
  agentMenuItems(api, view, "blank", calls.view)[0].run!();
  await vi.waitFor(() => expect(calls.view).toHaveBeenCalled(), { timeout: 2_000 });
  expect((calls.view.mock.calls[0][0] as ProfilesView).defaultAgent).toBe("blank");
});

it("entries list only agents that are on and installed, with their command", async () => {
  const { view } = await setup(async (a) => {
    const v = await a.profiles();
    await a.profilePut({ ...v.profiles.find((p) => p.profile.id === "codex")!.profile, enabled: false });
  });
  expect(pickerEntries(view).map((e) => e.id)).toEqual(["claude", "aider"]);
  expect(pickerEntries(view)[0].command).toBe("claude");
});
