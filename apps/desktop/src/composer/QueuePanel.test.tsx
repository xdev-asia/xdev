import { expect, it, vi } from "vitest";
import { Button, IconButton, ListRow, StatusDot, Textarea } from "@xdev-asia/ui";
import { createMockApi, type PromptQueueItem } from "@/api";
import { mount, nodes, textOf, type Node } from "@/kit/testHooks";
import { translate } from "@/i18n";
import { Composer, type ComposerTab } from "./Composer";
import { QueuePanel } from "./QueuePanel";
import { ScheduleForm } from "./ScheduleForm";

vi.mock("react", async (original) => {
  const patched = (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>());
  let n = 0;
  return { ...patched, useId: () => `id${n++}` };
});
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const item = (over: Partial<PromptQueueItem> & Pick<PromptQueueItem, "id" | "text">): PromptQueueItem => ({
  tabId: "t1",
  when: { kind: "idle" },
  status: "waiting",
  forced: false,
  createdAt: 1,
  ...over,
});
const action = (all: Node[], icon: string, row = 0) => all.filter((n) => n.type === IconButton && n.props.icon === icon)[row]!;
const noteOf = (all: Node[]) => textOf(all.find((n) => n.props["data-testid"] === "composer-queue-status")!);

async function panel(items: PromptQueueItem[]) {
  const api = createMockApi({});
  const onBack = vi.fn();
  const m = mount(QueuePanel, () => ({ api, items, account: null, quotas: [], onBack }));
  return { api, m, onBack, all: await m.settle() };
}

it("lists each queued prompt with its time and status, and every icon button is named", async () => {
  const { all } = await panel([
    item({ id: "1", text: "First\nmore", when: { kind: "at", at: 5 } }),
    item({ id: "2", text: "Second", status: "unconfirmed", when: { kind: "after_reset", quota: null, resetAt: null, nextCheckAt: 0 } }),
    item({ id: "3", text: "Third", status: "tab_closed" }),
  ]);
  const rows = all.filter((n) => n.type === ListRow);
  expect(rows.map((r) => textOf(r.props.title))).toEqual(["First", "Second", "Third"]);
  expect(rows[1]!.props.meta).toBe(t("composer.queue.when.resetUnknown"));
  expect(rows.map((r) => nodes(r.props.leading).find((n) => n.type === StatusDot)!.props.label)).toEqual([
    t("composer.queue.status.waiting"),
    t("composer.queue.status.unconfirmed"),
    t("composer.queue.status.tab_closed"),
  ]);
  expect(all.filter((n) => n.type === IconButton).every((n) => typeof n.props.label === "string" && n.props.label !== "")).toBe(true);
  // The ends of the list cannot move further.
  expect(action(all, "arrow-up", 0).props.disabled).toBe(true);
  expect(action(all, "arrow-down", 2).props.disabled).toBe(true);
  expect(action(all, "arrow-down", 0).props.disabled).toBe(false);
});

it("a paused prompt offers Retry and Skip, a waiting one Send now", async () => {
  const { all } = await panel([item({ id: "1", text: "a", status: "failed" }), item({ id: "2", text: "b" })]);
  const labels = all.filter((n) => n.type === Button).map((n) => textOf(n));
  expect(labels).toEqual([t("composer.queue.retry"), t("composer.queue.skip"), t("composer.queue.sendNow"), t("composer.templates.back")]);
});

it("Delete, Send now and move go through the api and are announced", async () => {
  const { api, m } = await panel([]);
  const a = await api.promptQueueAdd({ tabId: "t1", text: "alpha", when: { kind: "idle" } });
  const b = await api.promptQueueAdd({ tabId: "t1", text: "beta", when: { kind: "idle" } });
  const items = await api.promptQueueList();
  const m2 = mount(QueuePanel, () => ({ api, items, account: null, quotas: [], onBack() {} }));
  let all = await m2.settle();
  action(all, "arrow-up", 1).props.onClick();
  all = await m2.settle();
  expect((await api.promptQueueList()).map((i) => i.id)).toEqual([b.id, a.id]);
  expect(noteOf(all)).toBe(t("composer.queue.moved", { name: "beta" }));
  all.find((n) => n.type === Button && n.props.icon === "send")!.props.onClick();
  all = await m2.settle();
  expect((await api.promptQueueList()).find((i) => i.id === a.id)!.forced).toBe(true);
  action(all, "trash", 0).props.onClick();
  all = await m2.settle();
  expect((await api.promptQueueList()).map((i) => i.id)).toEqual([b.id]);
  expect(noteOf(all)).toBe(t("composer.queue.deleted", { name: "alpha" }));
  expect(all.find((n) => n.props["data-testid"] === "composer-queue-status")!.props.role).toBe("status");
  void m;
});

it("Edit opens the schedule form with the text, and saving updates the prompt", async () => {
  const { api, m } = await panel([]);
  const a = await api.promptQueueAdd({ tabId: "t1", text: "alpha", when: { kind: "idle" } });
  const items = await api.promptQueueList();
  const m2 = mount(QueuePanel, () => ({ api, items, account: null, quotas: [], onBack() {} }));
  let all = await m2.settle();
  action(all, "edit", 0).props.onClick();
  all = await m2.settle();
  const form = all.find((n) => n.type === ScheduleForm)!;
  expect(form.props.text).toBe("alpha");
  form.props.onSubmit({ kind: "in_minutes", minutes: 7 }, "alpha two");
  await m2.settle();
  const [saved] = await api.promptQueueList();
  expect(saved).toMatchObject({ id: a.id, text: "alpha two", when: { kind: "at" } });
  void m;
});

it("shows an empty state and a way back", async () => {
  const { all, onBack } = await panel([]);
  expect(textOf(all.find((n) => n.props.className === "composer-empty")!)).toBe(t("composer.queue.empty"));
  all.find((n) => n.type === Button)!.props.onClick();
  expect(onBack).toHaveBeenCalled();
});

it("the schedule form is valid only with a good time, and shows the quota reset it will wait for", async () => {
  const onSubmit = vi.fn();
  const mk = (quotas: { name: string; resetsAt: number | null; utilization: number | null }[]) =>
    mount(ScheduleForm, () => ({ account: "q", quotas, confirmLabel: "Add", onSubmit, onCancel() {} }));
  const m = mk([{ name: "q", resetsAt: Date.UTC(2030, 0, 1, 10, 0), utilization: 80 }]);
  let all = await m.settle();
  const submit = () => all.find((n) => n.type === Button && n.props.type === "submit")!;
  expect(submit().props.disabled).toBe(false);
  all.find((n) => n.props.label === t("composer.schedule.minutes"))!.props.onChange({ target: { value: "" } });
  all = await m.settle();
  expect(submit().props.disabled).toBe(true);
  all.find((n) => n.props.label === t("composer.schedule.when"))!.props.onChange("after_reset");
  all = await m.settle();
  const hint = textOf(all.find((n) => n.props["data-testid"] === "composer-reset-hint")!);
  expect(hint).toMatch(/^The 5-hour window resets at /);
  all.find((n) => n.type === "form")!.props.onSubmit({ preventDefault() {} });
  expect(onSubmit).toHaveBeenCalledWith({ kind: "after_reset", quota: "q", resetAt: Date.UTC(2030, 0, 1, 10, 0) }, undefined);
});

const TABS: ComposerTab[] = [{ id: "t1", label: "Claude · api", worktree: "/repo/api", agent: true, account: "q" }];

it("Schedule is disabled until there is a prompt, and queues the prompt for the tab", async () => {
  const api = createMockApi({});
  const m = mount(Composer, () => ({ api, target: TABS[0]!, tabs: TABS, initialMany: null, send: async () => "sent" as const, queue: { items: [], quotas: [] }, onClose() {} }));
  let all = await m.settle();
  const open = () => all.find((n) => n.props["data-testid"] === "composer-schedule-open")!;
  expect(textOf(open())).toBe(t("composer.schedule.open"));
  expect(open().props.disabled).toBe(true);
  expect(all.filter((n) => n.type === Button && (n.props.variant ?? "primary") === "primary")).toHaveLength(1);
  all.find((n) => n.type === Textarea)!.props.onChange({ target: { value: "Nightly run", selectionStart: 11 } });
  all = await m.settle();
  expect(open().props.disabled).toBe(false);
  open().props.onClick();
  all = await m.settle();
  const form = all.find((n) => n.type === ScheduleForm)!;
  expect(textOf(all.find((n) => n.type === "h2")!)).toBe(t("composer.schedule.title"));
  form.props.onSubmit({ kind: "in_minutes", minutes: 0 }, undefined);
  await m.settle();
  all = await m.settle();
  expect((await api.promptQueueList()).map((i) => [i.tabId, i.text])).toEqual([["t1", "Nightly run"]]);
  expect(textOf(all.find((n) => n.props["data-testid"] === "composer-status")!)).toBe(t("composer.queue.added", { count: 1 }));
});

it("the queue button carries the number of queued prompts of the tab", async () => {
  const api = createMockApi({});
  const items = [item({ id: "1", text: "a" }), item({ id: "2", text: "b", tabId: "other" }), item({ id: "3", text: "c" })];
  const m = mount(Composer, () => ({ api, target: TABS[0]!, tabs: TABS, initialMany: null, send: async () => "sent" as const, queue: { items, quotas: [] }, onClose() {} }));
  const all = await m.settle();
  expect(textOf(all.find((n) => n.props["data-testid"] === "composer-queue-open")!)).toBe(t("composer.queue.open.count", { count: 2 }));
});
