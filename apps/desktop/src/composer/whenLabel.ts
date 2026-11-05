import type { PromptQueueItem } from "@/api";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** A time as the person reads it: short date and time, in their locale. */
export function formatTime(at: number): string {
  return new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** When an item is sent, in words. */
export function whenLabel(item: Pick<PromptQueueItem, "when">, t: Translate): string {
  const w = item.when;
  if (w.kind === "at") return t("composer.queue.when.at", { time: formatTime(w.at) });
  if (w.kind === "idle") return t("composer.queue.when.idle");
  return w.resetAt === null ? t("composer.queue.when.resetUnknown") : t("composer.queue.when.reset", { time: formatTime(w.resetAt) });
}
