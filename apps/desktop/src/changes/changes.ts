import type { Change } from "../api";

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

// Code-unit order, the same as the Rust side, so the list does not jump when it refreshes.
export function sortChanges(changes: Change[]): Change[] {
  return [...changes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
