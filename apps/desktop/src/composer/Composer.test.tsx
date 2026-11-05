import { afterEach, expect, it, vi } from "vitest";
import { Button, Checkbox, IconButton, ListRow, Textarea } from "@xdev-asia/ui";
import { createMockApi } from "@/api";
import { mount, nodes, textOf, type Node } from "@/kit/testHooks";
import { translate } from "@/i18n";
import { Composer, type ComposerTab } from "./Composer";
import { TemplatesManager } from "./TemplatesManager";
import type { SendResult } from "./verify";

vi.mock("react", async (original) => {
  const patched = (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>());
  let n = 0;
  return { ...patched, useId: () => `id${n++}` };
});
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

afterEach(() => vi.useRealTimers());

const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const TABS: ComposerTab[] = [
  { id: "t1", label: "Claude · api", worktree: "/repo/api", agent: true },
  { id: "t2", label: "Codex · web", worktree: "/repo/web", agent: true },
  { id: "t3", label: "Shell · web", worktree: "/repo/web", agent: false },
];

function setup(over: { initialMany?: string[] | null; results?: Record<string, SendResult[]> } = {}) {
  const api = createMockApi({});
  const queue = Object.fromEntries(Object.entries(over.results ?? {}).map(([k, v]) => [k, [...v]]));
  const send = vi.fn(async (id: string, _text: string): Promise<SendResult> => queue[id]?.shift() ?? "sent");
  const onClose = vi.fn();
  const m = mount(Composer, () => ({ api, target: TABS[0]!, tabs: TABS, initialMany: over.initialMany ?? null, send, onClose }));
  return { api, m, send, onClose };
}

const rowAction = (all: Node[], icon: string) =>
  all.filter((n) => n.type === ListRow).flatMap((r) => nodes(r.props.trailing)).find((n) => n.type === IconButton && n.props.icon === icon)!;
const area = (all: Node[]) => all.find((n) => n.type === Textarea)!;
const status = (all: Node[]) => textOf(all.find((n) => n.props["data-testid"] === "composer-status")!);
const sendButton = (all: Node[]) => all.find((n) => n.type === Button && n.props.icon === "send")!;
const key = (k: string, extra: Partial<{ shiftKey: boolean }> = {}) => {
  const e = { key: k, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, nativeEvent: { isComposing: false }, defaultPrevented: false, ...extra, preventDefault: vi.fn(), stopPropagation: vi.fn() };
  e.preventDefault.mockImplementation(() => (e.defaultPrevented = true));
  return e;
};
const type = (all: Node[], value: string) => area(all).props.onChange({ target: { value, selectionStart: value.length } });
async function settle(m: ReturnType<typeof setup>["m"], times = 4) {
  let all = await m.settle();
  for (let i = 1; i < times; i++) all = await m.settle();
  return all;
}

it("is a labelled dialog with one primary button and a role=status line", async () => {
  const { m } = setup();
  const all = await settle(m);
  const panel = all.find((n) => n.props["data-testid"] === "composer")!;
  expect(panel.props.role).toBe("dialog");
  expect(textOf(all.find((n) => n.type === "h2")!)).toBe(t("composer.title", { tab: "Claude · api" }));
  expect(all.filter((n) => n.type === Button && (n.props.variant ?? "primary") === "primary")).toHaveLength(1);
  expect(all.filter((n) => n.type === IconButton).every((n) => typeof n.props.label === "string" && n.props.label !== "")).toBe(true);
  expect(all.find((n) => n.props["data-testid"] === "composer-status")!.props.role).toBe("status");
});

it("Enter sends to the bound tab, shows Sent and clears the stored draft", async () => {
  const { api, m, send } = setup();
  await api.composerDraftPut("t1", "Review the diff");
  let all = await settle(m);
  expect(area(all).props.value).toBe("Review the diff");
  const e = key("Enter");
  area(all).props.onKeyDown(e);
  expect(e.preventDefault).toHaveBeenCalled();
  all = await settle(m);
  expect(send).toHaveBeenCalledWith("t1", "Review the diff");
  expect(status(all)).toBe(t("composer.result.sent"));
  expect(area(all).props.value).toBe("");
  expect(await api.composerDraftGet("t1")).toBeNull();
});

it("Shift+Enter adds a line instead of sending; an empty prompt cannot be sent", async () => {
  const { m, send } = setup();
  let all = await settle(m);
  expect(sendButton(all).props.disabled).toBe(true);
  type(all, "line one");
  all = await settle(m);
  const e = key("Enter", { shiftKey: true });
  area(all).props.onKeyDown(e);
  expect(e.preventDefault).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(sendButton(all).props.disabled).toBe(false);
});

it("a send nobody confirmed keeps the draft and says Not confirmed", async () => {
  const { api, m } = setup({ results: { t1: ["unconfirmed"] } });
  let all = await settle(m);
  type(all, "Run the tests");
  all = await settle(m);
  sendButton(all).props.onClick();
  all = await settle(m);
  expect(status(all)).toBe(t("composer.result.unconfirmed"));
  expect(area(all).props.value).toBe("Run the tests");
  await new Promise((r) => setTimeout(r, 450));
  expect(await api.composerDraftGet("t1")).toBe("Run the tests");
});

it("@ lists open tabs and inserts the worktree path of the one picked", async () => {
  const { m } = setup();
  let all = await settle(m);
  type(all, "Compare with @web");
  all = await settle(m);
  expect(area(all).props["aria-expanded"]).toBe(true);
  const rows = all.filter((n) => n.type === ListRow);
  expect(rows.map((r) => textOf(r.props.title))).toContain("Codex · web");
  area(all).props.onKeyDown(key("Enter"));
  all = await settle(m);
  expect(area(all).props.value).toMatch(/^Compare with \/repo\/web /);
});

it("an append template is added on send, after the prompt", async () => {
  const { api, m, send } = setup();
  await api.promptTemplatesPut({ id: "rules", name: "House rules", body: "Keep commits small.", mode: "append" });
  let all = await settle(m);
  type(all, "Fix the bug @House");
  all = await settle(m);
  area(all).props.onKeyDown(key("Enter"));
  all = await settle(m);
  expect(area(all).props.value).toBe("Fix the bug ");
  expect(all.find((n) => n.props.role === "group")).toBeTruthy();
  area(all).props.onKeyDown(key("Enter"));
  await settle(m);
  expect(send).toHaveBeenCalledWith("t1", "Fix the bug\n\nKeep commits small.");
});

it("sends to several tabs, shows a result per tab and retries only the failed ones", async () => {
  const { m, send } = setup({ initialMany: ["t1", "t2"], results: { t2: ["failed", "sent"] } });
  let all = await settle(m);
  expect(all.filter((n) => n.props["data-testid"] === "composer-target")).toHaveLength(3);
  type(all, "Pull and rebase");
  all = await settle(m);
  expect(textOf(sendButton(all))).toBe(t("composer.sendMany", { count: 2 }));
  sendButton(all).props.onClick();
  all = await settle(m);
  expect(status(all)).toBe(t("composer.status.summary", { sent: 1, count: 2 }));
  const retry = all.find((n) => n.type === Button && n.props.icon === "refresh")!;
  expect(textOf(retry)).toBe(t("composer.retry", { count: 1 }));
  retry.props.onClick();
  all = await settle(m);
  expect(send.mock.calls.map((c) => c[0])).toEqual(["t1", "t2", "t2"]);
  expect(status(all)).toBe(t("composer.status.summary", { sent: 2, count: 2 }));
  expect(all.find((n) => n.type === Button && n.props.icon === "refresh")).toBeUndefined();
});

it("All agent tabs ticks every agent tab and leaves shells alone", async () => {
  const { m } = setup({ initialMany: [] });
  let all = await settle(m);
  const allAgents = all.find((n) => n.type === Checkbox && n.props.label === t("composer.many.allAgents"))!;
  allAgents.props.onChange({ target: { checked: true } });
  all = await settle(m);
  const ticked = all.filter((n) => n.type === Checkbox && n.props.checked).map((n) => n.props.label);
  expect(ticked).toEqual([t("composer.many"), t("composer.many.allAgents"), "Claude · api", "Codex · web"]);
});

it("Escape closes the panel", async () => {
  const { m, onClose } = setup();
  const all = await settle(m);
  all.find((n) => n.props["data-testid"] === "composer")!.props.onKeyDown(key("Escape"));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("the templates manager creates, edits and deletes templates", async () => {
  const api = createMockApi({});
  let list = await api.promptTemplatesList();
  const onBack = vi.fn();
  const m = mount(TemplatesManager, () => ({ api, templates: list, onChange: (next) => (list = next), onBack }));
  let all = await m.settle();
  expect(textOf(all.find((n) => n.props.className === "composer-empty")!)).toBe(t("composer.templates.empty"));
  all.find((n) => n.type === Button && n.props.icon === "plus")!.props.onClick();
  all = await m.settle();
  const form = () => all.find((n) => n.type === "form")!;
  expect(all.filter((n) => n.type === Button && n.props.type === "submit")).toHaveLength(1);
  all.find((n) => n.props.label === t("composer.templates.name"))!.props.onChange({ target: { value: "Review" } });
  all = await m.settle();
  all.find((n) => n.type === Textarea)!.props.onChange({ target: { value: "Review this change." } });
  all = await m.settle();
  form().props.onSubmit({ preventDefault() {} });
  all = await m.settle();
  all = await m.settle();
  expect(list.map((x) => [x.name, x.body, x.mode])).toEqual([["Review", "Review this change.", "insert"]]);
  expect(textOf(all.find((n) => n.props.role === "status")!)).toBe(t("composer.templates.saved"));

  rowAction(all, "edit").props.onClick();
  all = await m.settle();
  all.find((n) => n.props.label === t("composer.templates.mode") && n.props.options)!.props.onChange("append");
  all = await m.settle();
  form().props.onSubmit({ preventDefault() {} });
  all = await m.settle();
  all = await m.settle();
  expect(list.map((x) => x.mode)).toEqual(["append"]);

  rowAction(all, "trash").props.onClick();
  all = await m.settle();
  all = await m.settle();
  expect(list).toEqual([]);
  expect(textOf(all.find((n) => n.props.role === "status")!)).toBe(t("composer.templates.deleted", { name: "Review" }));
});
