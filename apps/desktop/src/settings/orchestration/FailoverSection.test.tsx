import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Button, Field, IconButton, Select, Switch } from "@xdev-asia/ui";
import { createMockApi, type OrchestrationSettings } from "@/api";
import { translate } from "@/i18n";
import en from "@/i18n/en.json";
import vi_ from "@/i18n/vi.json";
import { mount, textOf, type Node } from "@/kit/testHooks";
import { ORCHESTRATION_DEFAULTS } from "@/mockSettings";
import { FailoverSection, moved, parseWhole, type FailoverAgent } from "./FailoverSection";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const tr = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const AGENTS: FailoverAgent[] = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "aider", name: "Aider" },
];
const Section = FailoverSection as unknown as (p: Parameters<typeof FailoverSection>[0]) => ReactElement;

/** The section over the mock backend: each change is stored there, and the section is drawn with what came back. */
async function open(start: Partial<OrchestrationSettings> = {}) {
  const api = createMockApi({});
  let settings: OrchestrationSettings | null = await api.orchestrationSettingsPut({ ...ORCHESTRATION_DEFAULTS, ...start });
  const onChange = vi.fn(async (change: Partial<OrchestrationSettings>) => {
    settings = await api.orchestrationSettingsPut({ ...settings!, ...change });
    return true;
  });
  const m = mount(Section, () => ({ settings, agents: AGENTS, onChange }));
  await m.settle();
  return { api, m, onChange, stored: () => api.orchestrationSettings() };
}
const by = (all: Node[], field: string) => all.find((n) => n.props["data-field"] === field)!;
const status = (all: Node[]) => textOf(by(all, "failover-status"));
const button = (all: Node[], label: string) => all.find((n) => n.type === IconButton && n.props.label === label)!;
const settle = async (m: { settle(): Promise<Node[]> }) => {
  await m.settle();
  return m.settle();
};

it("starts off: failover off, backup account on, no backup agents, at most 2, autopilot off after 10 minutes", async () => {
  const { m } = await open();
  const all = m.all();
  const switches = all.filter((n) => n.type === Switch).map((n) => [n.props["data-field"], n.props.checked, n.props.label]);
  expect(switches).toEqual([
    ["failover", false, tr("settings.orchestration.failover.enabled")],
    ["failoverAccount", true, tr("settings.orchestration.failover.account")],
    ["autopilot", false, tr("settings.orchestration.failover.autopilot")],
  ]);
  expect(all.filter((n) => n.type === Field).map((n) => n.props.value)).toEqual(["2", "10"]);
  expect(textOf(by(all, "no-backup"))).toBe(tr("settings.orchestration.failover.noAgents"));
  expect(textOf(by(all, "failover-terms"))).toBe(tr("settings.orchestration.failover.terms"));
  expect(by(all, "failover-status").props.role).toBe("status");
  expect(all.find((n) => n.type === Select)!.props.options.map((o: { label: string }) => o.label)).toEqual(["Claude Code", "Codex", "Aider"]);
  // The add button is the section's only button, and it is not a primary one.
  const add = all.filter((n) => n.type === Button);
  expect(add.map((n) => [n.props.variant, n.props.type, n.props.children])).toEqual([["secondary", "button", tr("settings.orchestration.failover.add")]]);
});

it("the switches save and say so", async () => {
  const { m, stored } = await open();
  by(m.all(), "failover").props.onChange({ target: { checked: true } });
  let all = await settle(m);
  expect((await stored()).failoverEnabled).toBe(true);
  expect(by(all, "failover").props.checked).toBe(true);
  expect(status(all)).toBe(tr("settings.orchestration.failover.saved"));
  by(all, "failoverAccount").props.onChange({ target: { checked: false } });
  all = await settle(m);
  by(all, "autopilot").props.onChange({ target: { checked: true } });
  all = await settle(m);
  expect(await stored()).toMatchObject({ failoverBackupAccount: false, autopilotRestart: true });
});

it("adds backup agents in order, and the picker leaves out the ones already listed", async () => {
  const { m, stored } = await open();
  by(m.all(), "add-agent").props.onChange({ target: { value: "codex" } });
  m.all().find((n) => n.props["data-act"] === "add-backup")!.props.onClick();
  let all = await settle(m);
  expect((await stored()).failoverBackupAgents).toEqual(["codex"]);
  expect(status(all)).toBe(tr("settings.orchestration.failover.added", { name: "Codex", position: 1 }));
  expect(by(all, "add-agent").props.options.map((o: { value: string }) => o.value)).toEqual(["claude", "aider"]);
  all.find((n) => n.props["data-act"] === "add-backup")!.props.onClick();
  all = await settle(m);
  expect((await stored()).failoverBackupAgents).toEqual(["codex", "claude"]);
  expect(by(all, "backup-agents").type).toBe("ol");
  expect(all.filter((n) => n.type === "li").map((n) => n.props["data-agent"])).toEqual(["codex", "claude"]);
});

it("moves a backup agent by its labelled buttons, announces the place, and keeps the ends disabled", async () => {
  const { m, stored } = await open({ failoverBackupAgents: ["codex", "claude", "aider"] });
  let all = m.all();
  expect(button(all, "Move Codex up").props.disabled).toBe(true);
  expect(button(all, "Move Aider down").props.disabled).toBe(true);
  for (const n of all.filter((x) => x.type === IconButton)) expect(n.props.label).toBeTruthy();
  button(all, "Move Codex down").props.onClick();
  all = await settle(m);
  expect((await stored()).failoverBackupAgents).toEqual(["claude", "codex", "aider"]);
  expect(status(all)).toBe(tr("settings.orchestration.failover.moved", { name: "Codex", position: 2 }));
  button(all, "Move Aider up").props.onClick();
  all = await settle(m);
  expect((await stored()).failoverBackupAgents).toEqual(["claude", "aider", "codex"]);
  button(all, "Remove Aider").props.onClick();
  all = await settle(m);
  expect((await stored()).failoverBackupAgents).toEqual(["claude", "codex"]);
  expect(status(all)).toBe(tr("settings.orchestration.failover.removed", { name: "Aider" }));
});

it("the counts save whole numbers in range and show an error for anything else", async () => {
  const { m, stored, onChange } = await open();
  const max = () => m.all().find((n) => n.props["data-field"] === "failover-max")!;
  max().props.onChange({ target: { value: "9" } });
  expect(max().props.error).toBe(tr("settings.orchestration.failover.rangeError", { min: 1, max: 5 }));
  max().props.onBlur();
  expect(onChange).not.toHaveBeenCalled();
  max().props.onChange({ target: { value: "4" } });
  expect(max().props.error).toBeUndefined();
  max().props.onKeyDown({ key: "Enter" });
  await settle(m);
  expect((await stored()).failoverMax).toBe(4);
  const stuck = () => m.all().find((n) => n.props["data-field"] === "stuck-minutes")!;
  stuck().props.onChange({ target: { value: "0" } });
  expect(stuck().props.error).toBe(tr("settings.orchestration.failover.rangeError", { min: 1, max: 120 }));
  stuck().props.onChange({ target: { value: "15" } });
  stuck().props.onBlur();
  await settle(m);
  expect((await stored()).stuckMinutes).toBe(15);
});

it("says nothing when a save fails", async () => {
  const api = createMockApi({});
  const settings = await api.orchestrationSettings();
  const m = mount(Section, () => ({ settings, agents: AGENTS, onChange: async () => false }));
  await m.settle();
  by(m.all(), "failover").props.onChange({ target: { checked: true } });
  expect(status(await settle(m))).toBe("");
});

it("is disabled until the settings load", async () => {
  const m = mount(Section, () => ({ settings: null, agents: AGENTS, onChange: async () => true }));
  const all = await m.settle();
  expect(all.filter((n) => n.type === Switch || n.type === Field).every((n) => n.props.disabled === true)).toBe(true);
});

it("parses counts and moves items", () => {
  expect(parseWhole(" 3 ", 1, 5)).toBe(3);
  expect(parseWhole("3.5", 1, 5)).toBeNull();
  expect(parseWhole("", 1, 5)).toBeNull();
  expect(parseWhole("6", 1, 5)).toBeNull();
  expect(moved(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
  expect(moved(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
  expect(moved(["a", "b"], 0, -1)).toEqual(["a", "b"]);
});

it("every failover string is in English and Vietnamese", () => {
  const keys = Object.keys(en).filter((k) => k.startsWith("settings.orchestration.failover.") || k.startsWith("orchestration.failover.") || k.startsWith("orchestration.worker.fail") || k === "orchestration.worker.restarted");
  expect(keys.length).toBeGreaterThan(30);
  for (const k of keys) expect((vi_ as Record<string, string>)[k], k).toBeTruthy();
});
