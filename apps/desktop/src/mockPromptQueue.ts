import type {
  Api,
  ApiError,
  PromptQueueChanged,
  PromptQueueDue,
  PromptQueueFacts,
  PromptQueueItem,
  PromptQueueNew,
  PromptQueueReport,
  PromptQueueWhen,
  PromptQueueWhenInput,
} from "./api";

type QueueApi = Pick<
  Api,
  | "promptQueueList"
  | "promptQueueAdd"
  | "promptQueueUpdate"
  | "promptQueueDelete"
  | "promptQueueReorder"
  | "promptQueueSendNow"
  | "promptQueueReport"
  | "promptQueueFacts"
  | "onPromptQueueDue"
  | "onPromptQueueChanged"
>;

export type MockPromptQueue = QueueApi & {
  /** Runs one tick of the backend's scheduler now. */
  __promptQueueTick(): void;
};

/** The bounds of `xdev_automations::prompt_queue`. */
export const QUEUE_MAX_PER_TAB = 50;
export const QUEUE_MAX_BYTES = 16 * 1024;
export const QUOTA_POLL_MS = 5 * 60_000;
const FACTS_TTL_MS = 120_000;
/** The demo ticks every second so a short wait is seen; the backend ticks every minute. */
const TICK_MS = 1000;

const bytes = (text: string) => new TextEncoder().encode(text).length;

function reject(code: ApiError["code"], detail?: string): Promise<never> {
  const error: ApiError = detail === undefined ? { code } : { code, detail };
  return Promise.reject(error);
}

function resolve(when: PromptQueueWhenInput, now: number): PromptQueueWhen {
  switch (when.kind) {
    case "at":
      return { kind: "at", at: when.at };
    case "in_minutes":
      return { kind: "at", at: now + when.minutes * 60_000 };
    case "after_reset":
      return { kind: "after_reset", quota: when.quota, resetAt: when.resetAt, nextCheckAt: now };
    case "idle":
      return { kind: "idle" };
  }
}

export function createMockPromptQueue(): MockPromptQueue {
  let items: PromptQueueItem[] = [];
  let facts: { value: PromptQueueFacts; at: number } | null = null;
  let seq = 0;
  const dues = new Set<(e: PromptQueueDue) => void>();
  const changes = new Set<(e: PromptQueueChanged) => void>();
  // Each listener is its own handle, as with real events: the same callback twice is two listeners.
  const on = <E>(set: Set<(e: E) => void>, cb: (e: E) => void) => {
    const handle = (e: E) => cb(e);
    set.add(handle);
    return () => void set.delete(handle);
  };
  const changed = () => {
    for (const cb of changes) cb({} as PromptQueueChanged);
  };
  const tabItems = (tab: string) => items.filter((i) => i.tabId === tab);
  const find = (id: string) => items.find((i) => i.id === id);

  const live = (): PromptQueueFacts | null => {
    if (!facts || Date.now() - facts.at > FACTS_TTL_MS || !facts.value.ready) return null;
    return facts.value;
  };

  const tick = () => {
    const f = live();
    if (!f) return;
    const now = Date.now();
    const fire: PromptQueueItem[] = [];
    let touched = false;
    const seen = new Set<string>();
    for (const first of items) {
      const tab = first.tabId;
      if (seen.has(tab)) continue;
      seen.add(tab);
      const mine = tabItems(tab);
      if (mine.some((i) => i.status === "sending")) continue;
      const item = mine.find((i) => i.forced && i.status === "waiting") ?? mine.find((i) => i.status !== "tab_closed");
      if (!item || item.status !== "waiting") continue;
      const isLive = f.tabs.some((t) => t.id === tab);
      let due = item.forced;
      if (!due) {
        const w = item.when;
        if (w.kind === "at") due = now >= w.at;
        else if (w.kind === "idle") {
          const t = f.tabs.find((x) => x.id === tab);
          due = !t || t.idle;
        } else {
          const q = w.quota === null ? f.quotas[0] : f.quotas.find((x) => x.name === w.quota);
          const known = w.resetAt ?? q?.resetsAt ?? null;
          if (known !== null) {
            if (w.resetAt === null) {
              item.when = { ...w, resetAt: known };
              touched = true;
            }
            due = now >= known;
          } else if (now >= w.nextCheckAt) {
            if (q?.utilization != null && q.utilization < 100) due = true;
            else {
              item.when = { ...w, nextCheckAt: now + QUOTA_POLL_MS };
              touched = true;
            }
          }
        }
      }
      if (!due) continue;
      touched = true;
      item.forced = false;
      if (isLive) {
        item.status = "sending";
        fire.push(structuredClone(item));
      } else item.status = "tab_closed";
    }
    if (touched) changed();
    if (fire.length > 0) for (const cb of dues) cb({ items: fire });
  };

  // The scheduler runs once the window has reported, as the backend does.
  let timer: ReturnType<typeof setInterval> | null = null;

  const check = (text: string): Promise<never> | null =>
    text.trim() === "" ? reject("bad_arg", "empty") : bytes(text) > QUEUE_MAX_BYTES ? reject("too_large", "prompt") : null;

  return {
    async promptQueueList() {
      return structuredClone(items);
    },
    async promptQueueAdd(input: PromptQueueNew) {
      const bad = check(input.text);
      if (bad) return bad;
      if (tabItems(input.tabId).length >= QUEUE_MAX_PER_TAB) return reject("too_large", "items");
      const now = Date.now();
      const item: PromptQueueItem = {
        id: `pq-${++seq}`,
        tabId: input.tabId,
        text: input.text,
        when: resolve(input.when, now),
        status: "waiting",
        forced: false,
        createdAt: now,
      };
      items.push(item);
      changed();
      queueMicrotask(tick);
      return structuredClone(item);
    },
    async promptQueueUpdate(id, text, when) {
      const item = find(id);
      if (!item) return reject("not_found");
      if (item.status === "sending") return reject("bad_arg", "busy");
      const bad = check(text);
      if (bad) return bad;
      item.text = text;
      item.when = resolve(when, Date.now());
      item.forced = false;
      if (item.status === "tab_closed") item.status = "waiting";
      changed();
      queueMicrotask(tick);
      return structuredClone(item);
    },
    async promptQueueDelete(id) {
      const item = find(id);
      if (!item) return reject("not_found");
      if (item.status === "sending") return reject("bad_arg", "busy");
      items = items.filter((i) => i !== item);
      changed();
    },
    async promptQueueReorder(id, delta) {
      const item = find(id);
      if (!item) return reject("not_found");
      const at = items.indexOf(item);
      const mine = items.map((x, i) => (x.tabId === item.tabId ? i : -1)).filter((i) => i >= 0);
      const to = mine.indexOf(at) + Math.sign(delta);
      if (to < 0 || to >= mine.length) return;
      const other = mine[to];
      [items[at], items[other]] = [items[other], items[at]];
      changed();
    },
    async promptQueueSendNow(id) {
      const item = find(id);
      if (!item) return reject("not_found");
      if (item.status === "sending") return reject("bad_arg", "busy");
      item.status = "waiting";
      item.forced = true;
      changed();
      queueMicrotask(tick);
      return structuredClone(item);
    },
    async promptQueueReport(id, report: PromptQueueReport) {
      const item = find(id);
      if (!item) return reject("not_found");
      if (report === "sent") items = items.filter((i) => i !== item);
      else {
        item.forced = false;
        item.status = report === "failed" ? "failed" : "unconfirmed";
      }
      changed();
    },
    async promptQueueFacts(value) {
      const before = facts?.value;
      facts = { value: structuredClone(value), at: Date.now() };
      timer ??= setInterval(tick, TICK_MS);
      if (JSON.stringify(before) !== JSON.stringify(value)) queueMicrotask(tick);
    },
    async onPromptQueueDue(cb) {
      return on(dues, cb);
    },
    async onPromptQueueChanged(cb) {
      return on(changes, cb);
    },
    __promptQueueTick: tick,
  };
}
