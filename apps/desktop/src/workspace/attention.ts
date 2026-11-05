import type { StatusSettings } from "@/api";
import { eventOn } from "@/status/statusSettings";
import type { Attention } from "./sessions";

/** The i18n key of the words that say why a tab is unread. */
export function reasonKey(reason: Attention): string {
  return `attention.reason.${reason}`;
}

/**
 * Whether an unread tab counts for the bell, the badge and the Activity "Unread" filter under these
 * settings. A tab without a stored reason counts as `needs-you`.
 */
export function admits(reason: Attention | null, settings: StatusSettings): boolean {
  return eventOn(settings, reason ?? "needs-you");
}
