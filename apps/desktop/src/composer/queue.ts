import type { PromptQueueFacts, PromptQueueItem, PromptQueueQuotaFact, PromptQueueTabFact, PromptQueueWhen, PromptQueueWhenInput, Quota } from "@/api";
import type { Tab } from "@/workspace/sessions";

/** Facts older than this are dropped by the backend, so they are pushed again at least this often. */
export const FACTS_EVERY_MS = 30_000;
/** How often the quota is read while an item waits for a reset. */
export const QUOTA_EVERY_MS = 5 * 60_000;

/** The 5-hour window of each account or provider, as the backend wants it. */
export function quotaFacts(quotas: readonly Quota[]): PromptQueueQuotaFact[] {
  return quotas.flatMap((q) => {
    const w = q.windows.find((x) => x.key === "five_hour");
    if (!w) return [];
    const at = w.resetsAt === null ? NaN : Date.parse(w.resetsAt);
    return [{ name: q.name, resetsAt: Number.isFinite(at) ? at : null, utilization: w.utilization }];
  });
}

/** An agent that works or waits for the user is busy; a shell is always idle. */
export const isIdle = (tab: Pick<Tab, "agent" | "status">): boolean => !(tab.agent && (tab.status === "working" || tab.status === "needs-you"));

export function tabFacts(tabs: readonly Pick<Tab, "id" | "agent" | "status">[]): PromptQueueTabFact[] {
  return tabs.map((t) => ({ id: t.id, idle: isIdle(t) }));
}

export function buildFacts(tabs: readonly Pick<Tab, "id" | "agent" | "status">[], quotas: readonly Quota[]): PromptQueueFacts {
  return { ready: true, tabs: tabFacts(tabs), quotas: quotaFacts(quotas) };
}

/** The quota that governs a tab: its account's, else the roomiest, as the status bar does. */
export function quotaFor(account: string | null, facts: readonly PromptQueueQuotaFact[]): PromptQueueQuotaFact | null {
  if (account !== null) {
    const own = facts.find((q) => q.name === account);
    if (own) return own;
  }
  const open = facts.filter((q) => q.utilization !== null);
  const pool = open.length > 0 ? open : facts;
  return pool.reduce<PromptQueueQuotaFact | null>((best, q) => (best === null || (q.utilization ?? 0) < (best.utilization ?? 0) ? q : best), null);
}

/** The reset time an "after quota reset" item will use for `account`, if the quota says. */
export function resetFor(account: string | null, facts: readonly PromptQueueQuotaFact[]): { quota: string | null; resetAt: number | null } {
  const q = quotaFor(account, facts);
  return { quota: q?.name ?? null, resetAt: q?.resetsAt ?? null };
}

/** The first 80 characters of the first line, for a list row. */
export function preview(text: string, max = 80): string {
  const line = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  const one = line.trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** The reset time of an item that waits for one, when known. */
export function resetOf(when: PromptQueueWhen): number | null {
  return when.kind === "after_reset" ? when.resetAt : null;
}

/** Whether an item is stopped until the person decides. */
export const paused = (item: Pick<PromptQueueItem, "status">): boolean => item.status === "unconfirmed" || item.status === "failed";

/** Reads a `datetime-local` value ("2026-11-06T14:30") as a local time; null when it is not one. */
export function parseLocal(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
  return Number.isFinite(at) ? at : null;
}

/** A `datetime-local` value for a time, in local time. */
export function toLocal(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export type WhenKind = "at" | "in_minutes" | "after_reset" | "idle";

/** What the schedule form holds. */
export type WhenDraft = { kind: WhenKind; at: string; minutes: string };

/** The request for a form, or null while it is not valid. */
export function toInput(draft: WhenDraft, account: string | null, quotas: readonly PromptQueueQuotaFact[]): PromptQueueWhenInput | null {
  switch (draft.kind) {
    case "at": {
      const at = parseLocal(draft.at);
      return at === null ? null : { kind: "at", at };
    }
    case "in_minutes": {
      const minutes = Number(draft.minutes);
      return draft.minutes.trim() !== "" && Number.isInteger(minutes) && minutes >= 0 && minutes <= 10_080 ? { kind: "in_minutes", minutes } : null;
    }
    case "after_reset": {
      const r = resetFor(account, quotas);
      return { kind: "after_reset", quota: r.quota, resetAt: r.resetAt };
    }
    case "idle":
      return { kind: "idle" };
  }
}

/** A form that holds an item's schedule, to edit it. */
export function toDraft(when: PromptQueueWhen, now: number): WhenDraft {
  if (when.kind === "at") return { kind: "at", at: toLocal(when.at), minutes: "10" };
  return { kind: when.kind, at: toLocal(now + 3_600_000), minutes: "10" };
}
