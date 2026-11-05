import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { toApiError, type PromptQueueFacts, type PromptQueueItem } from "@/api";
import { createMockPromptQueue } from "./mockPromptQueue";

const MIN = 60_000;
const facts = (over: Partial<PromptQueueFacts> = {}): PromptQueueFacts => ({ ready: true, tabs: [{ id: "a", idle: true }, { id: "b", idle: true }], quotas: [], ...over });

beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
afterEach(() => vi.useRealTimers());

function setup() {
  const api = createMockPromptQueue();
  const due: PromptQueueItem[][] = [];
  void api.onPromptQueueDue((e) => due.push(e.items));
  return { api, due };
}

it("sends two zero-minute prompts of a tab one after the other, in order", async () => {
  const { api, due } = setup();
  const one = await api.promptQueueAdd({ tabId: "a", text: "one", when: { kind: "in_minutes", minutes: 0 } });
  const two = await api.promptQueueAdd({ tabId: "a", text: "two", when: { kind: "in_minutes", minutes: 0 } });
  await api.promptQueueFacts(facts());
  api.__promptQueueTick();
  expect(due.flat().map((i) => i.text)).toEqual(["one"]);
  expect((await api.promptQueueList()).map((i) => i.status)).toEqual(["sending", "waiting"]);
  await api.promptQueueReport(one.id, "sent");
  api.__promptQueueTick();
  expect(due.flat().map((i) => i.id)).toEqual([one.id, two.id]);
});

it("sends nothing until the window has reported its facts", async () => {
  const { api, due } = setup();
  await api.promptQueueAdd({ tabId: "a", text: "x", when: { kind: "in_minutes", minutes: 0 } });
  api.__promptQueueTick();
  expect(due).toEqual([]);
});

it("waits for a time and for a known quota reset, and goes after it", async () => {
  const { api, due } = setup();
  await api.promptQueueAdd({ tabId: "a", text: "later", when: { kind: "in_minutes", minutes: 5 } });
  await api.promptQueueAdd({ tabId: "b", text: "reset", when: { kind: "after_reset", quota: "q", resetAt: null } });
  const quotas = [{ name: "q", resetsAt: 1_000_000 + 10 * MIN, utilization: 100 }];
  await api.promptQueueFacts(facts({ quotas }));
  api.__promptQueueTick();
  expect(due).toEqual([]);
  const list = await api.promptQueueList();
  expect(list[1]!.when).toMatchObject({ kind: "after_reset", resetAt: 1_000_000 + 10 * MIN });
  vi.setSystemTime(1_000_000 + 5 * MIN);
  await api.promptQueueFacts(facts({ quotas }));
  api.__promptQueueTick();
  expect(due.flat().map((i) => i.text)).toEqual(["later"]);
  vi.setSystemTime(1_000_000 + 10 * MIN);
  await api.promptQueueFacts(facts({ quotas }));
  api.__promptQueueTick();
  expect(due.flat().map((i) => i.text)).toEqual(["later", "reset"]);
});

it("polls an unknown reset every five minutes and goes when there is room", async () => {
  const { api, due } = setup();
  await api.promptQueueAdd({ tabId: "a", text: "x", when: { kind: "after_reset", quota: null, resetAt: null } });
  await api.promptQueueFacts(facts({ quotas: [{ name: "q", resetsAt: null, utilization: 100 }] }));
  api.__promptQueueTick();
  expect(due).toEqual([]);
  expect(((await api.promptQueueList())[0]!.when as { nextCheckAt: number }).nextCheckAt).toBe(1_000_000 + 5 * MIN);
  vi.setSystemTime(1_000_000 + 5 * MIN);
  await api.promptQueueFacts(facts({ quotas: [{ name: "q", resetsAt: null, utilization: 40 }] }));
  api.__promptQueueTick();
  expect(due.flat()).toHaveLength(1);
});

it("goes at once for a reset in the past, and for an idle tab only when it is idle", async () => {
  const { api, due } = setup();
  await api.promptQueueAdd({ tabId: "a", text: "past", when: { kind: "after_reset", quota: "q", resetAt: 1 } });
  await api.promptQueueAdd({ tabId: "b", text: "idle", when: { kind: "idle" } });
  await api.promptQueueFacts(facts({ tabs: [{ id: "a", idle: true }, { id: "b", idle: false }] }));
  api.__promptQueueTick();
  expect(due.flat().map((i) => i.text)).toEqual(["past"]);
  await api.promptQueueFacts(facts());
  api.__promptQueueTick();
  expect(due.flat().map((i) => i.text)).toEqual(["past", "idle"]);
});

it("pauses a tab on a send that is not confirmed; Retry sends it again, Skip lets the next go", async () => {
  const { api, due } = setup();
  const one = await api.promptQueueAdd({ tabId: "a", text: "one", when: { kind: "in_minutes", minutes: 0 } });
  const two = await api.promptQueueAdd({ tabId: "a", text: "two", when: { kind: "in_minutes", minutes: 0 } });
  await api.promptQueueFacts(facts());
  api.__promptQueueTick();
  await api.promptQueueReport(one.id, "unconfirmed");
  api.__promptQueueTick();
  expect(due.flat()).toHaveLength(1);
  expect((await api.promptQueueList()).map((i) => i.status)).toEqual(["unconfirmed", "waiting"]);
  await api.promptQueueSendNow(one.id);
  api.__promptQueueTick();
  expect(due.flat().map((i) => i.id)).toEqual([one.id, one.id]);
  await api.promptQueueReport(one.id, "failed");
  await api.promptQueueDelete(one.id);
  api.__promptQueueTick();
  expect(due.flat().at(-1)!.id).toBe(two.id);
});

it("marks an item of a tab that is gone as tab_closed and does not send it", async () => {
  const { api, due } = setup();
  await api.promptQueueAdd({ tabId: "gone", text: "x", when: { kind: "in_minutes", minutes: 0 } });
  await api.promptQueueFacts(facts());
  api.__promptQueueTick();
  expect(due).toEqual([]);
  expect((await api.promptQueueList())[0]!.status).toBe("tab_closed");
});

it("reorders inside a tab, edits, deletes, and keeps the limits", async () => {
  const { api } = setup();
  const a = await api.promptQueueAdd({ tabId: "a", text: "a", when: { kind: "idle" } });
  await api.promptQueueAdd({ tabId: "b", text: "b", when: { kind: "idle" } });
  const c = await api.promptQueueAdd({ tabId: "a", text: "c", when: { kind: "idle" } });
  await api.promptQueueReorder(c.id, -1);
  expect((await api.promptQueueList()).map((i) => i.text)).toEqual(["c", "b", "a"]);
  await api.promptQueueReorder(c.id, -1);
  expect((await api.promptQueueList()).map((i) => i.text)).toEqual(["c", "b", "a"]);
  expect((await api.promptQueueUpdate(a.id, "a2", { kind: "in_minutes", minutes: 3 })).when).toEqual({ kind: "at", at: 1_000_000 + 3 * MIN });
  await api.promptQueueDelete(a.id);
  expect(await api.promptQueueList()).toHaveLength(2);
  const code = async (p: Promise<unknown>) => toApiError(await p.catch((e: unknown) => e)).code;
  expect(await code(api.promptQueueAdd({ tabId: "a", text: "  ", when: { kind: "idle" } }))).toBe("bad_arg");
  expect(await code(api.promptQueueAdd({ tabId: "a", text: "x".repeat(16 * 1024 + 1), when: { kind: "idle" } }))).toBe("too_large");
  for (let i = 0; i < 49; i++) await api.promptQueueAdd({ tabId: "a", text: `n${i}`, when: { kind: "idle" } });
  expect(await code(api.promptQueueAdd({ tabId: "a", text: "over", when: { kind: "idle" } }))).toBe("too_large");
});

it("tells listeners when the queue changes", async () => {
  const { api } = setup();
  const changed = vi.fn();
  await api.onPromptQueueChanged(changed);
  await api.promptQueueAdd({ tabId: "a", text: "x", when: { kind: "idle" } });
  expect(changed).toHaveBeenCalledTimes(1);
});
