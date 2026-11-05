import type { Answers } from "./onboardingState";

export const ITEMS = ["agent", "theme", "language", "notifications", "project"] as const;
export type ItemId = (typeof ITEMS)[number];

/** What the app already knows; a field is null until it has been read. */
export type Known = {
  /** The profiles' default agent (`auto` until one is picked). */
  defaultAgent: string | null;
  /** The saved theme (`system` until one is picked). */
  theme: string | null;
  /** The language the person picked, stored by the language switch. */
  storedLocale: boolean;
  /** Repos, folders and groups in the sidebar. */
  projects: number | null;
};

export type Row = { id: ItemId; done: boolean };

/** One row per item: done when the app state shows it, else when the wizard saved the answer. */
export function deriveChecklist(known: Known, answers: Answers): Row[] {
  const done: Record<ItemId, boolean> = {
    agent: answers.agent !== undefined || (known.defaultAgent !== null && known.defaultAgent !== "auto"),
    theme: answers.theme !== undefined || (known.theme !== null && known.theme !== "system"),
    language: answers.language !== undefined || known.storedLocale,
    notifications: answers.notifications === "allowed",
    project: (known.projects ?? 0) > 0,
  };
  return ITEMS.map((id) => ({ id, done: done[id] }));
}

export const isComplete = (rows: Row[]): boolean => rows.every((r) => r.done);
export const doneCount = (rows: Row[]): number => rows.filter((r) => r.done).length;
