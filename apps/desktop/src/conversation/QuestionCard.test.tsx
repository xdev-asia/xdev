import { afterEach, expect, it, vi } from "vitest";
import { Badge, Button, IconButton, Kbd, RadioGroup, Select } from "@xdev-asia/ui";
import { mount, nodes, textOf, tick, type Node } from "@/kit/testHooks";
import { translate } from "@/i18n";
import { ASK_DETAIL } from "./fixtures/hookDetails";
import { hookQuestion, transcriptQuestion, type Question } from "./questions";
import { QuestionBadge, QuestionCard, type QuestionCardProps } from "./QuestionCard";
import { clearQuestion, feedQuestions, noteTranscriptQuestion, resetQuestions } from "./questionStore";
import type { PtyHook } from "@/api";

vi.mock("react", async (original) => {
  const patched = (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>());
  let n = 0;
  return { ...patched, useId: () => `id${n++}` };
});
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

afterEach(() => resetQuestions());

const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

function setup(question: Question, over: Partial<QuestionCardProps> = {}) {
  const onSend = vi.fn(async (_keys: string) => true);
  const onOpenTerminal = vi.fn();
  const m = mount(QuestionCard, () => ({ question, agentName: "Claude Code", onSend, onOpenTerminal, ...over }));
  return { m, onSend, onOpenTerminal };
}

const button = (all: Node[], label: string) => all.find((n) => n.type === Button && textOf(n) === label);
const keysOf = (all: Node[]) => all.filter((n) => n.type === Kbd).map((n) => n.props.children as string);

it("shows the question, its header and its options with one primary button", () => {
  const { m } = setup(hookQuestion(ASK_DETAIL, "claude"));
  const all = m.all();
  const card = all.find((n) => n.props["data-testid"] === "question-card")!;
  expect(card.props.role).toBe("group");
  expect(card.props["data-kind"]).toBe("choice");
  expect(textOf(all.find((n) => n.type === "h3")!)).toBe(t("conversation.question.title", { name: "Claude Code" }));
  expect(all.find((n) => n.type === Badge)!.props.children).toBe("Cache");
  expect(all.some((n) => n.type === "p" && n.props.children === "Which database should the cache use?")).toBe(true);
  const radios = all.find((n) => n.type === RadioGroup)!;
  expect(radios.props.options.map((o: { label: string }) => o.label)).toEqual(["Redis", "SQLite", "In memory"]);
  expect(radios.props.options[1].hint).toBe("A file next to the app");
  expect(all.filter((n) => n.type === Button && (n.props.variant ?? "primary") === "primary")).toHaveLength(1);
});

it("picking an option shows the keys it sends and sends nothing", () => {
  const { m, onSend } = setup(hookQuestion(ASK_DETAIL, "claude"));
  let all = m.all();
  expect(keysOf(all)).toEqual(["1"]);
  all.find((n) => n.type === RadioGroup)!.props.onChange("1");
  all = m.all();
  expect(all.find((n) => n.type === RadioGroup)!.props.value).toBe("1");
  expect(keysOf(all)).toEqual(["2"]);
  expect(onSend).not.toHaveBeenCalled();
});

it("sends only after the confirm step, and cancel goes back", async () => {
  const { m, onSend } = setup(hookQuestion(ASK_DETAIL, "claude"));
  let all = m.all();
  all.find((n) => n.type === RadioGroup)!.props.onChange("1");
  all = m.all();
  button(all, t("conversation.question.send"))!.props.onClick();
  all = m.all();
  expect(onSend).not.toHaveBeenCalled();
  expect(all.some((n) => n.type === "p" && n.props.children === t("conversation.question.confirm.title", { name: "Claude Code", answer: "SQLite" }))).toBe(true);
  expect(keysOf(all)).toEqual(["2"]);
  const confirm = button(all, t("conversation.question.confirm.send"))!;
  expect(confirm.props.autoFocus).toBe(true);
  // Cancel: back to the options, the send button takes the focus.
  button(all, t("conversation.question.cancel"))!.props.onClick();
  all = m.all();
  expect(all.find((n) => n.type === RadioGroup)).toBeDefined();
  expect(button(all, t("conversation.question.send"))!.props.autoFocus).toBe(true);
  button(all, t("conversation.question.send"))!.props.onClick();
  all = m.all();
  await button(all, t("conversation.question.confirm.send"))!.props.onClick();
  expect(onSend).toHaveBeenCalledTimes(1);
  expect(onSend).toHaveBeenCalledWith("2");
});

it("a failed send says so and offers the options again", async () => {
  const onSend = vi.fn(async () => false);
  const { m } = setup(hookQuestion(ASK_DETAIL, "claude"), { onSend });
  button(m.all(), t("conversation.question.send"))!.props.onClick();
  button(m.all(), t("conversation.question.confirm.send"))!.props.onClick();
  await tick();
  const all = m.all();
  expect(onSend).toHaveBeenCalledWith("1");
  const error = all.find((n) => n.props.role === "alert")!;
  expect(textOf(error)).toBe(t("conversation.question.failed"));
  expect(all.find((n) => n.type === RadioGroup)).toBeDefined();
});

it("a permission shows the tool and sends 1 or Escape", async () => {
  const q = hookQuestion({ toolName: "Bash", toolInput: "rm -rf build", message: null, isInterrupt: false, error: null, question: { kind: "permission", text: "", header: null, options: [], multi: false, count: 1 } }, "claude");
  const { m, onSend } = setup(q);
  let all = m.all();
  expect(textOf(all.find((n) => n.type === "h3")!)).toBe(t("conversation.question.title.permission", { name: "Claude Code" }));
  expect(all.some((n) => n.type === "code" && n.props.children === "rm -rf build")).toBe(true);
  expect(all.find((n) => n.type === RadioGroup)!.props.options.map((o: { label: string }) => o.label)).toEqual(["Yes", "No"]);
  all.find((n) => n.type === RadioGroup)!.props.onChange("1");
  all = m.all();
  expect(keysOf(all)).toEqual([t("conversation.question.key.escape")]);
  button(all, t("conversation.question.send"))!.props.onClick();
  await button(m.all(), t("conversation.question.confirm.send"))!.props.onClick();
  expect(onSend).toHaveBeenCalledWith("\x1b");
});

it("a transcript question types the answer and Enter, and can be hidden", () => {
  const onDismiss = vi.fn();
  const { m } = setup(transcriptQuestion("Done.\n\nShould I commit?", "claude")!, { onDismiss });
  const all = m.all();
  expect(keysOf(all)).toEqual(["yes", t("conversation.question.key.enter")]);
  expect(all.some((n) => n.type === "p" && n.props.children === t("conversation.question.fromText"))).toBe(true);
  const hide = all.find((n) => n.type === IconButton)!;
  expect(hide.props.label).toBe(t("conversation.question.dismiss"));
  hide.props.onClick();
  expect(onDismiss).toHaveBeenCalled();
});

it("more than five options are a select", () => {
  const options = Array.from({ length: 7 }, (_, i) => ({ label: `Option ${i + 1}`, description: null }));
  const q = hookQuestion({ ...ASK_DETAIL, question: { ...ASK_DETAIL.question!, options } }, "claude");
  const { m } = setup(q);
  let all = m.all();
  expect(all.find((n) => n.type === RadioGroup)).toBeUndefined();
  const select = all.find((n) => n.type === Select)!;
  expect(select.props.options).toHaveLength(7);
  select.props.onChange({ currentTarget: { value: "6" } });
  all = m.all();
  expect(keysOf(all)).toEqual(["7"]);
});

it("a prompt it cannot answer for sure points to the terminal", () => {
  const { m, onSend, onOpenTerminal } = setup(hookQuestion({ ...ASK_DETAIL, question: { ...ASK_DETAIL.question!, multi: true } }, "claude"));
  const all = m.all();
  expect(all.find((n) => n.type === RadioGroup)).toBeUndefined();
  expect(all.some((n) => n.type === "p" && n.props.children === t("conversation.question.fallback"))).toBe(true);
  const open = button(all, t("conversation.question.openTerminal"))!;
  expect(open.props.variant ?? "primary").toBe("primary");
  open.props.onClick();
  expect(onOpenTerminal).toHaveBeenCalled();
  expect(onSend).not.toHaveBeenCalled();
  // A codex menu, and a needs-input without a question, fall back too.
  expect(nodes(setup(hookQuestion(ASK_DETAIL, "codex")).m.draw()).some((n) => n.props["data-testid"] === "question-terminal")).toBe(true);
  const waiting = setup(hookQuestion(null, "claude")).m.all();
  expect(textOf(waiting.find((n) => n.type === "h3")!)).toBe(t("conversation.question.title.waiting", { name: "Claude Code" }));
});

it("the tab badge shows while the question holds", async () => {
  let fire: ((h: PtyHook) => void) | null = null;
  const api = { onPtyHook: vi.fn(async (cb: (h: PtyHook) => void) => ((fire = cb), () => {})) };
  feedQuestions(api);
  feedQuestions(api);
  expect(api.onPtyHook).toHaveBeenCalledTimes(1);
  await Promise.resolve();
  const tab = { id: "t1", agent: true, status: "needs-you" };
  const badge = mount((p: Parameters<typeof QuestionBadge>[0]) => QuestionBadge(p) ?? <></>, () => ({ tab }));
  const shows = () => nodes(badge.draw()).some((n) => n.props["data-testid"] === "tab-question");
  expect(shows()).toBe(false);
  fire!({ id: "t1", event: "needs-input", at: 1, detail: ASK_DETAIL, session: null });
  const shown = nodes(badge.draw());
  expect(shows()).toBe(true);
  expect(shown.find((n) => n.type === Badge)!.props.children).toBe(t("conversation.question.badge"));
  // Another hook (the tool ran) clears it; so does an answer.
  fire!({ id: "t1", event: "resume", at: 2, detail: null, session: null });
  expect(shows()).toBe(false);
  fire!({ id: "t1", event: "needs-input", at: 3, detail: null, session: null });
  expect(shows()).toBe(true);
  clearQuestion("t1");
  expect(shows()).toBe(false);
  // A transcript question shows while the tab rests at its prompt, not while it works.
  noteTranscriptQuestion("t1", "Should I commit?");
  expect(shows()).toBe(false);
  tab.status = "done";
  expect(shows()).toBe(true);
  // Not on a plain shell.
  (tab as { agent: boolean }).agent = false;
  expect(shows()).toBe(false);
});
