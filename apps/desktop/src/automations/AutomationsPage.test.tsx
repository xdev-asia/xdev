import { afterEach, expect, it, vi } from "vitest";
import { createMockApi, type AutomationInput } from "@/api";
import type { MockApi } from "@/mockApi";
import { mount, nodes, tick, type Node } from "@/kit/testHooks";
import { translate } from "@/i18n";
import { DEMO_WORKSPACE } from "@/mockWorkspace";
import { getToasts, resetToastsForTests } from "@/workspace/toastStore";
import { AutomationDetail } from "./AutomationDetail";
import { AutomationList } from "./AutomationList";
import { AutomationsPage } from "./AutomationsPage";
import { TemplateEmptyState } from "./TemplateEmptyState";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

afterEach(resetToastsForTests);

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
  const buttons = all.filter((n) => n.props["data-act"] === "new" || n.props["data-act"] === "templates");
  expect(buttons.map((b) => [b.props["data-act"], b.props.variant])).toEqual([["templates", "secondary"], ["new", "primary"]]);
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
