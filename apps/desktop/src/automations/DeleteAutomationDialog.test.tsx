import { afterEach, expect, it, vi } from "vitest";
import { Checkbox } from "@xdev-asia/ui";
import { createMockApi, type Automation, type AutomationInput } from "@/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { mount, textOf } from "@/kit/testHooks";
import { translate } from "@/i18n";
import { getAutomationsSettings, resetAutomationsSettingsForTests } from "@/settings/automationsSettings";
import { getToasts, resetToastsForTests } from "@/workspace/toastStore";
import { DeleteAutomationDialog, deleteAutomation } from "./DeleteAutomationDialog";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

afterEach(() => {
  resetToastsForTests();
  resetAutomationsSettingsForTests();
});

const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const input: AutomationInput = {
  name: "Audit", prompt: "p", precheck: null, agent: "claude", extraAgentArgs: null, repoId: "r", workspaceMode: "existing", worktree: "/w", baseBranch: null, setupDecision: "inherit",
  reuseSession: false, timezone: "UTC", rrule: "FREQ=DAILY", dtstart: 0, enabled: true, missedRunGraceMinutes: 720,
};

async function made(over: Partial<AutomationInput> = {}): Promise<{ api: ReturnType<typeof createMockApi>; a: Automation }> {
  const api = createMockApi({});
  return { api, a: await api.automationCreate({ ...input, ...over }) };
}

it("asks with the title, the body and where the runs happen", () => {
  const { a } = { a: { name: "Audit", workspaceMode: "existing" } as Automation };
  const all = mount(DeleteAutomationDialog, () => ({ automation: a, onConfirm: vi.fn(), onCancel: vi.fn() })).all();
  const dialog = all.find((n) => n.type === ConfirmDialog)!;
  expect(dialog.props).toMatchObject({ open: true, title: "Delete automation", confirmLabel: "Delete" });
  expect(dialog.props.body).toBe("Delete Audit and its run history. Workspaces created by previous runs are not deleted.");
  expect(all.map((n) => n.props.children).filter((c) => typeof c === "string")).toContain("Runs in the selected workspace.");
  const fresh = mount(DeleteAutomationDialog, () => ({ automation: { name: "A", workspaceMode: "new_per_run" } as Automation, onConfirm: vi.fn(), onCancel: vi.fn() })).all();
  expect(fresh.map((n) => n.props.children).filter((c) => typeof c === "string")).toContain("Each run creates a new workspace.");
});

it("is closed without an automation", () => {
  const all = mount(DeleteAutomationDialog, () => ({ automation: null, onConfirm: vi.fn(), onCancel: vi.fn() })).all();
  expect(all.find((n) => n.type === ConfirmDialog)!.props.open).toBe(false);
});

it("confirms with the state of Don't ask again", () => {
  const onConfirm = vi.fn();
  const m = mount(DeleteAutomationDialog, () => ({ automation: { name: "A", workspaceMode: "existing" } as Automation, onConfirm, onCancel: vi.fn() }));
  const box = () => m.all().find((n) => n.type === Checkbox)!;
  expect(box().props.label).toBe("Don't ask again");
  m.all().find((n) => n.type === ConfirmDialog)!.props.onConfirm();
  expect(onConfirm).toHaveBeenLastCalledWith(false);
  box().props.onChange({ target: { checked: true } });
  m.all().find((n) => n.type === ConfirmDialog)!.props.onConfirm();
  expect(onConfirm).toHaveBeenLastCalledWith(true);
  expect(textOf(m.all().find((n) => n.type === ConfirmDialog)!)).toBeDefined();
});

it("starts each opening with Don't ask again cleared", async () => {
  let automation: Automation | null = { name: "A", workspaceMode: "existing" } as Automation;
  const m = mount(DeleteAutomationDialog, () => ({ automation, onConfirm: vi.fn(), onCancel: vi.fn() }));
  const box = () => m.all().find((n) => n.type === Checkbox)!;
  await m.settle();
  box().props.onChange({ target: { checked: true } });
  expect(box().props.checked).toBe(true);
  automation = null;
  await m.settle();
  automation = { name: "B", workspaceMode: "existing" } as Automation;
  await m.settle();
  expect(box().props.checked).toBe(false);
});

it("deletes without touching the preference when Don't ask again is off", async () => {
  const { api, a } = await made();
  await deleteAutomation(api, a, { dontAsk: false, openSettings: vi.fn(), t });
  expect((await api.automationsList()).automations).toEqual([]);
  expect(getToasts().map((x) => x.text)).toEqual(["Automation deleted."]);
  expect(await api.automationsSettings()).toEqual({ showButton: true, skipDeleteConfirm: false });
});

it("Don't ask again stores the setting and toasts how to change it, with Open Settings", async () => {
  const { api, a } = await made();
  const openSettings = vi.fn();
  await deleteAutomation(api, a, { dontAsk: true, openSettings, t });
  expect((await api.automationsList()).automations).toEqual([]);
  expect(await api.automationsSettings()).toEqual({ showButton: true, skipDeleteConfirm: true });
  expect(getAutomationsSettings().skipDeleteConfirm).toBe(true);
  const toast = getToasts().find((x) => x.actions.length > 0)!;
  expect(toast.text).toBe("We'll skip this confirmation next time. You can change this in Settings.");
  expect(toast.actions.map((x) => x.label)).toEqual(["Open Settings"]);
  toast.actions[0].run();
  expect(openSettings).toHaveBeenCalledWith("automations");
});

it("a failed delete stores nothing", async () => {
  const { api, a } = await made();
  await api.automationDelete(a.id);
  await expect(deleteAutomation(api, a, { dontAsk: true, openSettings: vi.fn(), t })).rejects.toMatchObject({ code: "not_found" });
  expect(await api.automationsSettings()).toEqual({ showButton: true, skipDeleteConfirm: false });
});
