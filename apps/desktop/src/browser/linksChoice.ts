import { useSyncExternalStore } from "react";
import type { Api, LinksTarget } from "@/api";
import { getBrowserSettings, setBrowserSettings } from "./browserSettings";

// The first click on a web link in a terminal asks once where links open. The answer is the setting `browser.openLinksIn`.

export const LINKS_ASKED_KEY = "xdev.links.asked";

type Store = Pick<Storage, "getItem" | "setItem">;
const defaultStore = (): Store | null => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};

export function loadLinksAsked(store: Store | null = defaultStore()): boolean {
  try {
    return store?.getItem(LINKS_ASKED_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveLinksAsked(store: Store | null = defaultStore()): void {
  try {
    store?.setItem(LINKS_ASKED_KEY, "1");
  } catch {
    // The question may come once more.
  }
}

/**
 * Whether the question is due. A setting other than the default was chosen by the person (in Settings), and an answer
 * given before is final.
 */
export function needsLinksChoice(setting: LinksTarget, asked: boolean): boolean {
  return !asked && setting === "system";
}

export type LinksAnswer = { kind: "skip" } | { kind: "chosen"; target: LinksTarget } | { kind: "cancel" };

// One question at a time: a second click while it is open joins it.
let pending: Promise<LinksTarget | null> | null = null;
let resolvePending: ((target: LinksTarget | null) => void) | null = null;
const listeners = new Set<() => void>();
const emit = (): void => {
  for (const l of [...listeners]) l();
};

export const useLinksChoicePending = (): boolean =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => pending !== null,
    () => false,
  );

/** The dialog's answer: a target, or null when it was closed without a choice. */
export function answerLinksChoice(target: LinksTarget | null): void {
  const resolve = resolvePending;
  pending = null;
  resolvePending = null;
  emit();
  resolve?.(target);
}

function request(): Promise<LinksTarget | null> {
  if (!pending) {
    pending = new Promise((resolve) => {
      resolvePending = resolve;
    });
    emit();
  }
  return pending;
}

/**
 * Asks where links open when the question is due, and writes the setting. Choosing counts as "don't ask again".
 * `skip`: nothing was asked, the setting stands. `cancel`: the dialog was closed; ask again next time.
 */
export async function askLinksTarget(api: Pick<Api, "browserSettingsPut">, store: Store | null = defaultStore()): Promise<LinksAnswer> {
  const settings = getBrowserSettings();
  if (!needsLinksChoice(settings.openLinksIn, loadLinksAsked(store))) {
    if (settings.openLinksIn !== "system") saveLinksAsked(store);
    return { kind: "skip" };
  }
  const target = await request();
  if (target === null) return { kind: "cancel" };
  try {
    setBrowserSettings(await api.browserSettingsPut({ ...settings, openLinksIn: target }));
    saveLinksAsked(store);
  } catch {
    // This click follows the choice; the question comes again because nothing was saved.
  }
  return { kind: "chosen", target };
}

/** Tests only. */
export function resetLinksChoiceForTests(): void {
  pending = null;
  resolvePending = null;
  listeners.clear();
}
