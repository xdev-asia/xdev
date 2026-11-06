import type { Api } from "../api";
import { TERMINAL_SCHEMES } from "../terminal/terminalThemes";

// An app theme may name a terminal colour scheme (`terminalScheme`). Applying such a theme sets the
// terminal scheme; leaving it puts back what the person had chosen. `planTerminalScheme` is the
// pure part; `syncTerminalScheme` reads and writes the terminal settings around it.

/** The two scheme ids a terminal setting holds: `theme`, and `themeLight` for light mode. */
export type SchemePair = { theme: string; themeLight: string };

/** What the person had chosen (`own`) and what the theme set (`applied`), kept while a theme owns the scheme. */
export type SchemeMemory = { own: SchemePair; applied: SchemePair };

export type SchemePlan = {
  /** The terminal settings to write; null when they already are right. */
  set: SchemePair | null;
  /** What to keep for next time; null when no theme owns the scheme any more. */
  memory: SchemeMemory | null;
};

const same = (a: SchemePair, b: SchemePair): boolean => a.theme === b.theme && a.themeLight === b.themeLight;

/**
 * `current` is the terminal scheme now, `memory` what an earlier call kept, `scheme` the active
 * theme's `terminalScheme` (null: none, or one this machine does not have).
 *
 * - A scheme: the person's own pair is kept (unless a theme already owns it); the terminal gets the
 *   scheme. When the person changed the scheme meanwhile, that choice is the one to keep.
 * - No scheme: the kept pair goes back, unless the person changed the scheme since the theme set
 *   it; then their choice stands.
 */
export function planTerminalScheme(current: SchemePair, memory: SchemeMemory | null, scheme: string | null): SchemePlan {
  if (scheme !== null) {
    const target: SchemePair = { theme: scheme, themeLight: scheme };
    const own = memory && same(current, memory.applied) ? memory.own : current;
    return { set: same(current, target) ? null : target, memory: { own, applied: target } };
  }
  if (!memory) return { set: null, memory: null };
  const untouched = same(current, memory.applied);
  return { set: untouched && !same(current, memory.own) ? memory.own : null, memory: null };
}

/** localStorage key of the kept `SchemeMemory`. */
export const SCHEME_MEMORY_KEY = "xdev.terminalSchemeOwn";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const isPair = (v: unknown): v is SchemePair =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as SchemePair).theme === "string" &&
  typeof (v as SchemePair).themeLight === "string";

function safeStorage(): Store | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function readSchemeMemory(storage: Store | undefined = safeStorage()): SchemeMemory | null {
  try {
    const raw = storage?.getItem(SCHEME_MEMORY_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<SchemeMemory>) : null;
    return v && isPair(v.own) && isPair(v.applied) ? { own: v.own, applied: v.applied } : null;
  } catch {
    return null;
  }
}

function writeSchemeMemory(memory: SchemeMemory | null, storage: Store | undefined): void {
  try {
    if (memory) storage?.setItem(SCHEME_MEMORY_KEY, JSON.stringify(memory));
    else storage?.removeItem(SCHEME_MEMORY_KEY);
  } catch {
    // Without storage a theme still applies; only the way back to the own scheme is lost.
  }
}

let queue: Promise<void> = Promise.resolve();

/**
 * Makes the terminal scheme match the active theme's `terminalScheme` (null: the person's own).
 * Calls run one after another. A failed read or write leaves the terminal as it is.
 */
export function syncTerminalScheme(
  api: Pick<Api, "terminalSettings" | "terminalSettingsPut" | "terminalThemes">,
  scheme: string | null,
  storage: Store | undefined = safeStorage(),
): Promise<void> {
  const run = async (): Promise<void> => {
    try {
      const s = await api.terminalSettings();
      let wanted = scheme;
      if (wanted !== null && !TERMINAL_SCHEMES.some((x) => x.id === wanted)) {
        const custom = await api.terminalThemes().catch(() => []);
        if (!custom.some((x) => x.id === wanted)) wanted = null;
      }
      const plan = planTerminalScheme({ theme: s.theme, themeLight: s.themeLight }, readSchemeMemory(storage), wanted);
      writeSchemeMemory(plan.memory, storage);
      if (plan.set) await api.terminalSettingsPut({ ...s, ...plan.set });
    } catch {
      // The terminal keeps what it has.
    }
  };
  queue = queue.then(run, run);
  return queue;
}
