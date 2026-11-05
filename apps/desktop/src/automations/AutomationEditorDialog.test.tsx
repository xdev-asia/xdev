import { afterEach, expect, it, vi } from "vitest";
import { Segmented } from "@xdev-asia/ui";
import { createMockApi, type Automation, type ScheduleProblem } from "@/api";
import { mount, textOf, type Node } from "@/kit/testHooks";
import { translate } from "@/i18n";
import { DEMO_WORKSPACE } from "@/mockWorkspace";
import { getToasts, resetToastsForTests } from "@/workspace/toastStore";
import { AutomationEditorDialog } from "./AutomationEditorDialog";
import { CustomCronPanel } from "./CustomCronPanel";
import { ExtraArgsField } from "./ExtraArgsField";
import { GraceField } from "./GraceField";
import { SchedulePicker } from "./SchedulePicker";
import { TEMPLATES } from "./templates";
import type { Agent } from "./editorModel";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

afterEach(resetToastsForTests);

const repos = DEMO_WORKSPACE.repos;
const repo = repos[0];
const worktree = repo.worktrees[0].path;
const agents: Agent[] = [{ id: "claude", name: "Claude", enabled: true, installed: true }, { id: "codex", name: "Codex", enabled: true, installed: true }];

function setup(over: Partial<Parameters<typeof AutomationEditorDialog>[0]> = {}) {
  const api = createMockApi({});
  const onSaved = vi.fn();
  const onCancel = vi.fn();
  const props = { api, repos, agents, defaultAgent: "claude", defaultRepo: repo.id, automation: null, onSaved, onCancel, ...over };
  const m = mount(AutomationEditorDialog, () => props);
  return { api, m, onSaved, onCancel };
}

const act = (all: Node[], name: string) => all.find((n) => n.props["data-act"] === name || n.props.action === name);
const typed = (value: string) => ({ target: { value } });
const submit = (all: Node[]) => all.find((n) => n.type === "form")!.props.onSubmit({ preventDefault() {} });
const problem = (all: Node[]) => {
  const n = all.find((x) => x.props.id === "au-editor-problem");
  return n ? textOf(n) : null;
};
const fill = (m: ReturnType<typeof setup>["m"], withWorktree = true) => {
  act(m.all(), "prompt")!.props.onChange(typed("Audit the repo"));
  if (withWorktree) act(m.all(), "workspace")!.props.onChange(typed(worktree));
};

it("titles the dialog by what it does, with one primary button", async () => {
  const { m } = setup();
  const all = await m.settle();
  expect(textOf(all.find((n) => n.type === "h2")!)).toBe("Create automation");
  const save = act(all, "save")!;
  expect(textOf(save)).toBe("Create");
  expect(save.props.type).toBe("submit");
  expect(all.filter((n) => n.props.variant === "primary" || (n.type !== "button" && n.props.type === "submit"))).toHaveLength(1);
  expect(act(all, "name")!.props.placeholder).toBe("Weekday repo audit");
  expect(act(all, "prompt")!.props.placeholder).toBe("Run the weekly dependency audit and summarize risky changes.");
});

it("fills the name, prompt, schedule and grace from a template and keeps the agent", async () => {
  const { m } = setup({ defaultAgent: "codex" });
  const menu = act(await m.settle(), "use-template")!;
  const items = menu.props.items as { label: string; onSelect(): void }[];
  expect(items.map((i) => i.label)).toEqual(TEMPLATES.map((t) => translate("en", `automations.templates.${t.id}.label`)));
  items.find((i) => i.label === "Release readiness review")!.onSelect();
  const all = m.all();
  expect(act(all, "name")!.props.value).toBe("Release readiness review");
  expect(String(act(all, "prompt")!.props.value)).toContain("Review the changes merged");
  expect(find(all, SchedulePicker).props.draft).toMatchObject({ preset: "weekly", dayOfWeek: 4, hour: 14 });
  expect(find(all, GraceField).props.value).toBe(1440);
  expect(act(all, "agent")!.props.value).toBe("codex");
});

function find(all: Node[], type: unknown | string): Node {
  return all.find((n) => n.type === type || (typeof n.type === "function" && n.type.name === type))!;
}

it("starts from a template when it is given one", async () => {
  const { m } = setup({ template: TEMPLATES[3] });
  const all = await m.settle();
  expect(act(all, "name")!.props.value).toBe("Hourly maintenance check");
  expect(find(all, SchedulePicker).props.draft).toMatchObject({ preset: "hourly", minute: 15 });
});

it("sends the create payload", async () => {
  const { api, m, onSaved } = setup();
  const create = vi.spyOn(api, "automationCreate");
  const before = Date.now();
  await m.settle();
  fill(m);
  submit(m.all());
  await vi.waitFor(() => expect(onSaved).toHaveBeenCalled(), { timeout: 5_000 });
  const sent = create.mock.calls[0][0];
  expect(sent).toMatchObject({
    name: "Untitled automation", prompt: "Audit the repo", precheck: null, agent: "claude", extraAgentArgs: null, repoId: repo.id, workspaceMode: "existing", worktree, baseBranch: null,
    setupDecision: "inherit", reuseSession: false, rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0", enabled: true, missedRunGraceMinutes: 720,
  });
  expect(sent.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  expect(sent.dtstart).toBeGreaterThanOrEqual(before);
  expect(getToasts().map((t) => t.text)).toEqual(["Automation saved."]);
  expect((await api.automationsList()).automations[0].name).toBe("Untitled automation");
});

it("shows Branch from instead of Workspace for a new run each time", async () => {
  const { m } = setup();
  let all = await m.settle();
  expect(act(all, "workspace")).toBeDefined();
  expect(act(all, "branch-from")).toBeUndefined();
  const location = all.find((n) => n.type === Segmented && n.props.label === "Run location")!;
  expect(location.props.options.map((o: { label: string }) => o.label)).toEqual(["Worktree", "New run"]);
  location.props.onChange("new_per_run");
  all = m.all();
  expect(act(all, "workspace")).toBeUndefined();
  expect(act(all, "branch-from")!.props.placeholder).toBe("Project default");
  expect(all.find((n) => n.type === Segmented && n.props.label === "Session")).toBeUndefined();
  expect(act(all, "setup")).toBeDefined();
});

it("says what is missing before it saves", async () => {
  const { api, m } = setup();
  const create = vi.spyOn(api, "automationCreate");
  await m.settle();
  submit(m.all());
  expect(problem(m.all())).toBe("Choose a run location and enter a prompt before saving.");
  fill(m, false);
  submit(m.all());
  expect(problem(m.all())).toBe("Choose an available workspace before saving.");
  act(m.all(), "workspace")!.props.onChange(typed(worktree));
  act(m.all(), "agent")!.props.onChange(typed(""));
  submit(m.all());
  expect(problem(m.all())).toBe("Choose an enabled agent before saving.");
  act(m.all(), "agent")!.props.onChange(typed("claude"));
  find(m.all(), SchedulePicker).props.onChange({ preset: "custom", hour: 9, minute: 0, dayOfWeek: 1, cron: "" });
  submit(m.all());
  expect(problem(m.all())).toBe("Enter a valid advanced schedule before saving.");
  expect(create).not.toHaveBeenCalled();
});

it("asks the backend about a custom cron once typing rests and tells the picker", async () => {
  const { api, m } = setup();
  const validate = vi.spyOn(api, "automationValidateSchedule").mockResolvedValue({ key: "invalid", field: null, max: null });
  await m.settle();
  find(m.all(), SchedulePicker).props.onChange({ preset: "custom", hour: 9, minute: 0, dayOfWeek: 1, cron: "0 9" });
  await m.settle();
  await vi.waitFor(() => expect(validate).toHaveBeenCalledWith("0 9", expect.any(String)), { timeout: 5_000 });
  await m.settle();
  expect(find(m.all(), SchedulePicker).props.cronError).toEqual({ key: "invalid", field: null, max: null });
});

it("offers fresh sessions when extra arguments meet a reused session, and does not save until it is fixed", async () => {
  const { api, m } = setup();
  const create = vi.spyOn(api, "automationCreate");
  await m.settle();
  fill(m);
  m.all().find((n) => n.type === Segmented && n.props.label === "Session")!.props.onChange("reuse");
  find(m.all(), ExtraArgsField).props.onChange("--model opus");
  const field = find(m.all(), ExtraArgsField);
  expect(field.props.conflict).toBe(true);
  submit(m.all());
  expect(create).not.toHaveBeenCalled();
  // The conflict is shown even with Advanced collapsed: Advanced opens, and the footer says why.
  expect(m.all().find((n) => n.type === "details")!.props.open).toBe(true);
  expect(textOf(m.all().find((n) => n.props.id === "au-editor-problem")!)).toBe("Extra arguments require a fresh session for every run.");
  field.props.onUseFresh();
  expect(find(m.all(), ExtraArgsField).props.conflict).toBe(false);
  submit(m.all());
  await vi.waitFor(() => expect(create).toHaveBeenCalled(), { timeout: 5_000 });
  expect(create.mock.calls[0][0]).toMatchObject({ extraAgentArgs: "--model opus", reuseSession: false });
});

it("shows what the backend refused in the extra arguments", async () => {
  const { api, m } = setup();
  vi.spyOn(api, "automationCreate").mockRejectedValue({ code: "extra_args", detail: JSON.stringify({ code: "optionNotAllowed", option: "--bad" }) });
  await m.settle();
  fill(m);
  find(m.all(), ExtraArgsField).props.onChange("--bad x");
  submit(m.all());
  await vi.waitFor(() => expect(find(m.all(), ExtraArgsField).props.error).toEqual({ code: "optionNotAllowed", option: "--bad" }), { timeout: 5_000 });
  expect(getToasts()).toEqual([]);
});

it("says the save failed", async () => {
  const { api, m, onSaved } = setup();
  vi.spyOn(api, "automationCreate").mockRejectedValue({ code: "io" });
  await m.settle();
  fill(m);
  submit(m.all());
  await vi.waitFor(() => expect(getToasts()).toHaveLength(1), { timeout: 5_000 });
  expect(getToasts()[0].text).toContain("Failed to save automation.");
  expect(onSaved).not.toHaveBeenCalled();
});

it("edits an automation: keeps its id, its start and its state, and sends an update", async () => {
  const api = createMockApi({});
  const made: Automation = await api.automationCreate({
    name: "Nightly", prompt: "Look", precheck: { command: "ls", timeoutSeconds: 30 }, agent: "claude", extraAgentArgs: null, repoId: repo.id, workspaceMode: "existing", worktree,
    baseBranch: null, setupDecision: "inherit", reuseSession: false, timezone: "Asia/Ho_Chi_Minh", rrule: "FREQ=DAILY;BYHOUR=16;BYMINUTE=30", dtstart: 1234, enabled: false, missedRunGraceMinutes: 180,
  });
  const update = vi.spyOn(api, "automationUpdate");
  const onSaved = vi.fn();
  const m = mount(AutomationEditorDialog, () => ({ api, repos, agents, defaultAgent: "claude", defaultRepo: repo.id, automation: made, onSaved, onCancel: vi.fn() }));
  let all = await m.settle();
  expect(textOf(all.find((n) => n.type === "h2")!)).toBe("Edit automation");
  expect(textOf(act(all, "save")!)).toBe("Save changes");
  expect(act(all, "name")!.props.value).toBe("Nightly");
  act(all, "name")!.props.onChange(typed("Renamed"));
  submit(m.all());
  await vi.waitFor(() => expect(onSaved).toHaveBeenCalled(), { timeout: 5_000 });
  expect(update.mock.calls[0][0]).toBe(made.id);
  expect(update.mock.calls[0][1]).toMatchObject({ name: "Renamed", timezone: "Asia/Ho_Chi_Minh", dtstart: 1234, enabled: false, missedRunGraceMinutes: 180, precheck: { command: "ls", timeoutSeconds: 30 } });
  expect(getToasts().map((t) => t.text)).toEqual(["Automation updated."]);
  all = m.all();
  expect(all.length).toBeGreaterThan(0);
});

it("cancels from the button and from Escape", async () => {
  const { m, onCancel } = setup();
  const all = await m.settle();
  act(all, "cancel")!.props.onClick();
  all.find((n) => n.type === "dialog")!.props.onCancel({ preventDefault() {} });
  expect(onCancel).toHaveBeenCalledTimes(2);
});

it("the custom cron panel says what to type, what is wrong, and when it is fine", () => {
  const text = (cron: string, error: ScheduleProblem | null) =>
    mount(CustomCronPanel, () => ({ cron, error, onChange: vi.fn() })).all().filter((n) => n.type !== "li" && typeof n.props.children === "string").map((n) => n.props.children);
  expect(text("", null)).toContain("Enter a five-field cron.");
  expect(text("0 9", { key: "invalid", field: null, max: null })).toContain("Enter a valid five-field cron before saving.");
  expect(text("0 */25 * * *", { key: "step", field: "hour", max: 24 })).toContain("Cron hour step must be between 1 and 24.");
  expect(text("0 9 * * 1-5", null)).toContain("Valid custom cron");
  const all = mount(CustomCronPanel, () => ({ cron: "0 9 * * 1-5", error: null, onChange: vi.fn() })).all();
  expect(all.filter((n) => n.type === "span").map(textOf)).toEqual(["Minute", "Hour", "Day", "Month", "Weekday"]);
  expect(find(all, "Field").props.label).toBe("Cron expression");
});

it("the extra arguments field shows the fix for a reused session and the backend's refusal", () => {
  const onUseFresh = vi.fn();
  const all = mount(ExtraArgsField, () => ({ value: "--model x", conflict: true, error: { code: "unsupported" as const }, onChange: vi.fn(), onUseFresh })).all();
  const button = act(all, "use-fresh")!;
  expect(textOf(button)).toBe("Use fresh sessions");
  button.props.onClick();
  expect(onUseFresh).toHaveBeenCalled();
  expect(all.map((n) => n.props.children).filter((c) => typeof c === "string")).toEqual(expect.arrayContaining(["Extra arguments require a fresh session for every run.", "Extra arguments aren't supported for this agent yet."]));
});
