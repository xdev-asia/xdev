import type { Theme } from "@xdev/bindings";
import type { Locale } from "@/i18n";

/** localStorage key of the first-run wizard's outcome and answers. */
export const ONBOARDING_KEY = "xdev.onboarding.v1";

/** What the person picked in the wizard; a key is missing until its step was passed. */
export type Answers = {
  agent?: string;
  shell?: string;
  theme?: Theme;
  language?: Locale;
  /** "allowed" once the OS took a notification, "denied" when it refused. */
  notifications?: "allowed" | "denied";
};

/** `status` is null until the wizard is finished or skipped. */
export type Saved = { status: "done" | "skipped" | null; answers: Answers };

export const EMPTY_SAVED: Saved = { status: null, answers: {} };

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

const THEMES: readonly string[] = ["system", "dark", "light"];

const text = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** Keeps only well-formed answers, so an edited or older file cannot break the checklist. */
function cleanAnswers(raw: unknown): Answers {
  const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const answers: Answers = {};
  const agent = text(r.agent);
  const shell = text(r.shell);
  if (agent) answers.agent = agent;
  if (shell) answers.shell = shell;
  if (typeof r.theme === "string" && THEMES.includes(r.theme)) answers.theme = r.theme as Theme;
  if (r.language === "en" || r.language === "vi") answers.language = r.language;
  if (r.notifications === "allowed" || r.notifications === "denied") answers.notifications = r.notifications;
  return answers;
}

/** Parses the stored text; anything unreadable is a first run. */
export function parseSaved(raw: string | null | undefined): Saved {
  if (!raw) return EMPTY_SAVED;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return EMPTY_SAVED;
    const v = value as Record<string, unknown>;
    const status = v.status === "done" || v.status === "skipped" ? v.status : null;
    return { status, answers: cleanAnswers(v.answers) };
  } catch {
    return EMPTY_SAVED;
  }
}

function browserStorage(): Storage | undefined {
  return typeof window !== "undefined" ? window.localStorage : undefined;
}

/** The stored outcome, or a first run when there is none or storage fails. */
export function loadSaved(storage: () => Storage | undefined = browserStorage): Saved {
  try {
    return parseSaved(storage()?.getItem(ONBOARDING_KEY));
  } catch {
    return EMPTY_SAVED;
  }
}

/** Stores the outcome; false when storage fails (the choice then lasts for this run only). */
export function writeSaved(saved: Saved, storage: () => Storage | undefined = browserStorage): boolean {
  try {
    const target = storage();
    if (!target) return false;
    target.setItem(ONBOARDING_KEY, JSON.stringify(saved));
    return true;
  } catch {
    return false;
  }
}

/** True while the wizard still has to run: neither finished nor skipped. */
export function isFirstRun(saved: Saved): boolean {
  return saved.status === null;
}
