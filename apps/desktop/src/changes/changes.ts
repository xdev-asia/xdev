import type { Change } from "@/api";

export type Message = { key: string; vars?: Record<string, string | number> };

const MAX_COUNT = 99;

// Keeps the tab label short however many files an agent touched.
export function countLabel(count: number): string {
  return count > MAX_COUNT ? `${MAX_COUNT}+` : String(count);
}

// Rejecting an added file deletes it, which deserves a sharper question than discarding edits.
export function rejectPrompt(changes: Change[]): Message {
  if (changes.length === 1) {
    const [{ path, kind }] = changes;
    return { key: kind === "added" ? "changes.reject.delete" : "changes.reject.discardOne", vars: { path } };
  }
  return { key: "changes.reject.discardMany", vars: { count: changes.length } };
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Coarse on purpose: the list answers "how long ago", the commit id answers "exactly when".
export function relativeTime(nowSec: number, timeSec: number): Message {
  const ago = nowSec - timeSec;
  if (ago < MINUTE) return { key: "time.justNow" };
  if (ago < HOUR) return { key: "time.min", vars: { n: Math.floor(ago / MINUTE) } };
  if (ago < DAY) return { key: "time.hour", vars: { n: Math.floor(ago / HOUR) } };
  return { key: "time.day", vars: { n: Math.floor(ago / DAY) } };
}

// Code-unit order, the same as the Rust side, so the list does not jump when it refreshes.
export function sortChanges(changes: Change[]): Change[] {
  return [...changes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
