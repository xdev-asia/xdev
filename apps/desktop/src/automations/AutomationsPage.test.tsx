import { afterEach, expect, it, vi } from "vitest";
import { createMockApi, type AutomationInput } from "@/api";
import type { MockApi } from "@/mockApi";
import { mount, nodes, tick, type Node } from "@/kit/testHooks";
import { translate } from "@/i18n";
import { DEMO_WORKSPACE } from "@/mockWorkspace";
import { getToasts, resetToastsForTests } from "@/workspace/toastStore";
import { resetAutomationsSettingsForTests, setAutomationsSettings } from "@/settings/automationsSettings";
import { AutomationDetail } from "./AutomationDetail";
import { AutomationEditorDialog } from "./AutomationEditorDialog";
import { AutomationList } from "./AutomationList";
import { AutomationRunDetails } from "./AutomationRunDetails";
import { AutomationsPage } from "./AutomationsPage";
import { DeleteAutomationDialog } from "./DeleteAutomationDialog";
import { TemplateEmptyState } from "./TemplateEmptyState";
import { TEMPLATES } from "./templates";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

afterEach(() => {
  resetToastsForTests();
  resetAutomationsSettingsForTests();
});

const NOW = 1_793_793_600_000;
const repos = DEMO_WORKSPACE.repos;

function input(over: Partial<AutomationInput> = {}): AutomationInput {
  return {
    name: "Audit", prompt: "Check deps", precheck: null, agent: "claude", extraAgentArgs: null, repoId: repos[0].id, workspaceMode: "existing", worktree: repos[0].worktrees[0].path,
    baseBranch: null, setupDecision: "inherit", reuseSession: false, timezone: "UTC", rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0", dtstart: NOW, enabled: true,
    missedRunGraceMinutes: 720, ...over,
  };
}

async function open(seed: (api: MockApi) => Promise<void> = async () => {}) {
  const api = createMockApi({});
  await seed(api);
  const m = mount(AutomationsPage, () => ({ api, repos, now: () => NOW }));
  for (let i = 0; i < 3; i++) await m.settle();
  return { api, m };
}

const find = (all: Node[], type: unknown) => all.find((n) => n.type === type);
const act = (all: Node[], name: string) => all.find((n) => n.props["data-act"] === name);
const typed = (value: string) => ({ target: { value } });
const toast = () => getToasts().map((t) => t.text);

it("shows the templates when there is nothing yet", async () => {
  const { m } = await open();
  const all = m.all();
  expect(find(all, TemplateEmptyState)).toBeDefined();
  expect(find(all, AutomationList)).toBeUndefined();
});

it("has the toolbar: search, filters, refresh, the secondary template button and the one primary", async () => {
  const { m } = await open();
  const all = m.all();
  expect(all.find((n) => n.props.placeholder === "Search...")).toBeDefined();
  expect(act(all, "refresh")).toBeDefined();
  // Refresh, New automation, then Start from a template.
  const buttons = all.filter((n) => ["refresh", "new", "templates"].includes(n.props["data-act"]));
  expect(buttons.map((b) => [b.props["data-act"], b.props.variant])).toEqual([["refresh", undefined], ["new", "primary"], ["templates", "secondary"]]);
  expect(all.filter((n) => n.props.variant === "primary")).toHaveLength(1);
});

it("lists the automations with their project and schedule", async () => {
  const { m } = await open(async (api) => {
    await api.automationCreate(input({ name: "Audit" }));
    await api.automationCreate(input({ name: "Hourly", rrule: "FREQ=HOURLY;BYMINUTE=15" }));
  });
  const list = find(m.all(), AutomationList)!;
  expect(list.props.rows.map((r: { automation: { name: string } }) => r.automation.name)).toEqual(["Audit", "Hourly"]);
  expect(list.props.rows[0].project).toBe(repos[0].shortName);
  expect(Object.values(list.props.schedules)).toEqual(["Weekdays at 9:00 AM", "Hourly at :15"]);
});

it("says nothing matches a search, and nothing matches the filters", async () => {
  const { m } = await open(async (api) => void (await api.automationCreate(input())));
  find(m.all(), AutomationList);
  const search = m.all().find((n) => n.props.placeholder === "Search...")!;
  search.props.onChange(typed("zzzz"));
  await m.settle();
  const emptySearch = find(m.all(), AutomationList);
  expect(emptySearch).toBeUndefined();
  expect(m.all().map((n) => n.props.title).filter(Boolean)).toContain("No automations match your search");
  search.props.onClear();
  await m.settle();
  expect(find(m.all(), AutomationList)).toBeDefined();
  const filters = m.all().find((n) => n.props.action === "filters")!;
  const items = filters.props.items as { label: string; onSelect?: () => void }[];
  items.find((i) => i.label === "Failed")!.onSelect!();
  await m.settle();
  expect(m.all().map((n) => n.props.title).filter(Boolean)).toContain("No automations match your filters");
});

it("sorts when a header is clicked", async () => {
  const { m } = await open(async (api) => {
    await api.automationCreate(input({ name: "Beta" }));
    await api.automationCreate(input({ name: "Alpha" }));
  });
  const names = () => find(m.all(), AutomationList)!.props.rows.map((r: { automation: { name: string } }) => r.automation.name);
  expect(names()).toEqual(["Beta", "Alpha"]);
  find(m.all(), AutomationList)!.props.onSort("name");
  await m.settle();
  expect(names()).toEqual(["Alpha", "Beta"]);
  find(m.all(), AutomationList)!.props.onSort("name");
  await m.settle();
  expect(names()).toEqual(["Beta", "Alpha"]);
});

it("Run now starts a run and says it is queued", async () => {
  const { api, m } = await open(async (a) => void (await a.automationCreate(input())));
  const id = (await api.automationsList()).automations[0].id;
  const run = vi.spyOn(api, "automationRunNow");
  find(m.all(), AutomationList)!.props.onAction(id, "run");
  await tick();
  expect(run).toHaveBeenCalledWith(id);
  expect(toast()).toEqual(["Automation run queued."]);
  expect((await api.automationRuns(id))).toHaveLength(1);
});

it("Run now says so when the previous run has not finished", async () => {
  const { api, m } = await open(async (a) => void (await a.automationCreate(input())));
  const id = (await api.automationsList()).automations[0].id;
  await api.automationRunNow(id);
  find(m.all(), AutomationList)!.props.onAction(id, "run");
  await tick();
  expect(toast()).toEqual(["The previous run has not finished yet."]);
  expect((await api.automationRuns(id))).toHaveLength(1);
});

it("pauses and resumes", async () => {
  const { api, m } = await open(async (a) => void (await a.automationCreate(input())));
  const id = (await api.automationsList()).automations[0].id;
  find(m.all(), AutomationList)!.props.onAction(id, "toggle");
  await tick();
  expect((await api.automationsList()).automations[0].enabled).toBe(false);
  await m.settle();
  await m.settle();
  find(m.all(), AutomationList)!.props.onAction(id, "toggle");
  await tick();
  expect((await api.automationsList()).automations[0].enabled).toBe(true);
  expect(toast()).toEqual(["Automation paused.", "Automation resumed."]);
});

it("selecting a row shows its detail and its run history", async () => {
  const { api, m } = await open(async (a) => {
    const made = await a.automationCreate(input());
    a.__automationAddRun({ automationId: made.id, status: "completed" });
  });
  expect(find(m.all(), AutomationDetail)).toBeUndefined();
  const id = (await api.automationsList()).automations[0].id;
  find(m.all(), AutomationList)!.props.onSelect(id);
  await m.settle();
  await m.settle();
  const detail = find(m.all(), AutomationDetail)!;
  expect(detail.props.automation.id).toBe(id);
  expect(detail.props.runs).toHaveLength(1);
  expect(detail.props.schedule).toBe("Weekdays at 9:00 AM");
  expect(detail.props.project).toBe(repos[0].shortName);
  expect(nodes(m.draw()).length).toBeGreaterThan(0);
});

it("loads again when the backend says something changed", async () => {
  const { api, m } = await open(async (a) => void (await a.automationCreate(input())));
  await api.automationCreate(input({ name: "Later" }));
  await m.settle();
  await m.settle();
  expect(find(m.all(), AutomationList)!.props.rows).toHaveLength(2);
});

it("New automation opens the empty editor; a template opens it filled", async () => {
  const { m } = await open(async (a) => void (await a.automationCreate(input())));
  expect(find(m.all(), AutomationEditorDialog)).toBeUndefined();
  act(m.all(), "new")!.props.onClick();
  await m.settle();
  const blank = find(m.all(), AutomationEditorDialog)!;
  expect([blank.props.automation, blank.props.template]).toEqual([null, null]);
  blank.props.onCancel();
  await m.settle();
  expect(find(m.all(), AutomationEditorDialog)).toBeUndefined();

  act(m.all(), "templates")!.props.onClick();
  await m.settle();
  expect(find(m.all(), AutomationList)).toBeUndefined();
  find(m.all(), TemplateEmptyState)!.props.onPick(TEMPLATES[1]);
  await m.settle();
  const filled = find(m.all(), AutomationEditorDialog)!;
  expect(filled.props.template).toBe(TEMPLATES[1]);
  expect(find(m.all(), TemplateEmptyState)).toBeUndefined();
  expect(find(m.all(), AutomationList)).toBeDefined();
});

it("Edit opens the editor on that automation, and saving selects it", async () => {
  const { api, m } = await open(async (a) => void (await a.automationCreate(input())));
  const made = (await api.automationsList()).automations[0];
  find(m.all(), AutomationList)!.props.onAction(made.id, "edit");
  await m.settle();
  const editor = find(m.all(), AutomationEditorDialog)!;
  expect(editor.props.automation.id).toBe(made.id);
  editor.props.onSaved(made);
  await m.settle();
  await m.settle();
  expect(find(m.all(), AutomationEditorDialog)).toBeUndefined();
  expect(find(m.all(), AutomationDetail)!.props.automation.id).toBe(made.id);
});

it("Delete asks first, then deletes, and with Don't ask again keeps the choice", async () => {
  const openSettings = vi.fn();
  const api = createMockApi({});
  const made = await api.automationCreate(input());
  const m = mount(AutomationsPage, () => ({ api, repos, now: () => NOW, openSettings }));
  for (let i = 0; i < 3; i++) await m.settle();
  find(m.all(), AutomationList)!.props.onAction(made.id, "delete");
  await m.settle();
  const dialog = find(m.all(), DeleteAutomationDialog)!;
  expect(dialog.props.automation.id).toBe(made.id);
  expect((await api.automationsList()).automations).toHaveLength(1);
  dialog.props.onConfirm(true);
  await tick();
  await tick();
  expect((await api.automationsList()).automations).toHaveLength(0);
  expect((await api.automationsSettings()).skipDeleteConfirm).toBe(true);
  expect(toast()).toEqual(["Automation deleted.", "We'll skip this confirmation next time. You can change this in Settings."]);
  getToasts()[1].actions![0].run();
  expect(openSettings).toHaveBeenCalledWith("automations");
});

it("deletes at once when the confirmation is switched off", async () => {
  const { api, m } = await open(async (a) => void (await a.automationCreate(input())));
  setAutomationsSettings({ showButton: true, skipDeleteConfirm: true });
  const id = (await api.automationsList()).automations[0].id;
  find(m.all(), AutomationList)!.props.onAction(id, "delete");
  await tick();
  await tick();
  expect(find(m.all(), DeleteAutomationDialog)!.props.automation).toBeNull();
  expect((await api.automationsList()).automations).toHaveLength(0);
  expect(toast()).toEqual(["Automation deleted."]);
});

it("opens a run's details, goes back, and reruns", async () => {
  const onOpenWorkspace = vi.fn();
  const api = createMockApi({});
  const made = await api.automationCreate(input());
  const run = api.__automationAddRun({ automationId: made.id, status: "completed", worktree: repos[0].worktrees[0].path });
  const m = mount(AutomationsPage, () => ({ api, repos, now: () => NOW, onOpenWorkspace }));
  for (let i = 0; i < 3; i++) await m.settle();
  find(m.all(), AutomationList)!.props.onSelect(made.id);
  await m.settle();
  await m.settle();
  find(m.all(), AutomationDetail)!.props.onOpenRun(run);
  await m.settle();
  const details = find(m.all(), AutomationRunDetails)!;
  expect(details.props.run.id).toBe(run.id);
  expect(find(m.all(), AutomationList)).toBeUndefined();
  details.props.onOpenWorkspace(repos[0].worktrees[0].path);
  expect(onOpenWorkspace).toHaveBeenCalledWith(repos[0].worktrees[0].path);
  details.props.onBack();
  await m.settle();
  expect(find(m.all(), AutomationRunDetails)).toBeUndefined();
  expect(find(m.all(), AutomationList)).toBeDefined();

  find(m.all(), AutomationDetail)!.props.onOpenRun(run);
  await m.settle();
  find(m.all(), AutomationRunDetails)!.props.onRerun();
  await tick();
  expect(await api.automationRuns(made.id)).toHaveLength(2);
  expect(toast()).toContain("Automation run queued.");
  await m.settle();
  expect(find(m.all(), AutomationRunDetails)).toBeUndefined();
});
